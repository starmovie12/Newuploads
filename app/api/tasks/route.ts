export const dynamic = 'force-dynamic';
export const maxDuration = 60; // Allow up to 60s for Vercel Pro (default is 10s)

import { NextResponse } from 'next/server';
import { db } from '@/lib/firebaseAdmin';
import {
  extractMovieLinks,
  solveHBLinks,
  solveHubCDN,
  solveHubDrive,
} from '@/lib/solvers';

const API_MAP = {
  timer: 'https://time-page-bay-pass-edhc.onrender.com/solve?url=',
  hblinks: 'https://hblinks-dad.onrender.com/solve?url=',
  hubdrive: 'https://hdhub4u-1.onrender.com/solve?url=',
  hubcloud: 'http://85.121.5.246:5000/solve?url=',
  hubcdn_bypass: 'https://hubcdn-bypass.onrender.com/extract?url=',
};

// =============================================
// HELPER: Telegram Alert
// =============================================
async function sendTelegramAlert(failedUrl: string, errorMessage: string) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;

  const message = `🚨 MFLIX ERROR 🚨\nURL: ${failedUrl}\nError: ${errorMessage}`;
  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
    });
  } catch (e: any) {
    console.error('[Telegram] Failed to send alert:', e.message);
  }
}

// =============================================
// GET /api/tasks — List recent tasks
// =============================================
export async function GET() {
  try {
    const snapshot = await db
      .collection('scraping_tasks')
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();

    const tasks = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    return NextResponse.json(tasks);
  } catch (e: any) {
    console.error('[GET /api/tasks] Error:', e.message);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// =============================================
// POST /api/tasks — Create or merge a scraping task
// =============================================
export async function POST(req: Request) {
  // ---- Step 1: Parse request body safely ----
  let url: string;
  try {
    const body = await req.json();
    url = body?.url;
  } catch (parseError: any) {
    console.error('[POST /api/tasks] JSON parse error:', parseError.message);
    return NextResponse.json(
      { error: 'Invalid JSON in request body' },
      { status: 400 }
    );
  }

  if (!url || typeof url !== 'string' || !url.trim()) {
    return NextResponse.json({ error: 'URL is required' }, { status: 400 });
  }

  const trimmedUrl = url.trim();

  try {
    // ---- Step 2: Duplicate check ----
    // FIX: Use a SIMPLE query (single field) to avoid requiring a Firestore composite index.
    // The old code used .where('url', '==', ...).orderBy('createdAt', 'desc') which
    // REQUIRES a composite index. Without it, Firestore throws an error instantly → 500.
    let existingTaskId: string | null = null;
    let existingTaskData: any = null;

    try {
      const existingSnapshot = await db
        .collection('scraping_tasks')
        .where('url', '==', trimmedUrl)
        .limit(5) // Get a few, we'll sort client-side
        .get();

      if (!existingSnapshot.empty) {
        // Sort client-side by createdAt descending to get the most recent
        const sorted = existingSnapshot.docs
          .map((doc) => ({ id: doc.id, data: doc.data() }))
          .sort((a, b) => {
            const timeA = a.data.createdAt || '';
            const timeB = b.data.createdAt || '';
            return timeB > timeA ? 1 : timeB < timeA ? -1 : 0;
          });

        existingTaskId = sorted[0].id;
        existingTaskData = sorted[0].data;
      }
    } catch (dupCheckErr: any) {
      // If duplicate check fails (e.g., missing index), log but continue.
      // We'll just create a new task instead of crashing.
      console.warn('[POST /api/tasks] Duplicate check failed, creating new task:', dupCheckErr.message);
    }

    // ---- Step 3: Extract links from the source page ----
    const listResult = await extractMovieLinks(trimmedUrl);

    // ---- Step 4: If duplicate exists, merge ----
    if (existingTaskId && existingTaskData) {
      if (listResult.status === 'success' && listResult.links) {
        const existingLinks: any[] = existingTaskData.links || [];
        const existingLinkUrls = new Set(existingLinks.map((l: any) => l.link));

        const newLinksToAdd = listResult.links
          .filter((l: any) => !existingLinkUrls.has(l.link))
          .map((l: any) => ({ ...l, status: 'processing', logs: [] }));

        if (newLinksToAdd.length > 0) {
          const mergedLinks = [...existingLinks, ...newLinksToAdd];
          await db.collection('scraping_tasks').doc(existingTaskId).update({
            status: 'processing',
            links: mergedLinks,
            metadata: listResult.metadata || existingTaskData.metadata,
            preview: listResult.preview || existingTaskData.preview,
            updatedAt: new Date().toISOString(),
          });

          // Fire-and-forget background solving (won't survive Vercel response cutoff,
          // but stream_solve handles the real work via SSE)
          runBackgroundSolving(existingTaskId, newLinksToAdd, trimmedUrl, existingLinks.length).catch(
            (err) => console.error('[BG Solve Merge] Error:', err.message)
          );
        }

        return NextResponse.json({
          taskId: existingTaskId,
          metadata: listResult.metadata,
          preview: listResult.preview,
          merged: true,
          newLinksAdded: newLinksToAdd.length,
        });
      }

      // No new links, return existing
      return NextResponse.json({
        taskId: existingTaskId,
        metadata: existingTaskData.metadata,
        preview: existingTaskData.preview,
        merged: true,
        newLinksAdded: 0,
      });
    }

    // ---- Step 5: Create new task ----
    const taskData: Record<string, any> = {
      url: trimmedUrl,
      status: 'processing',
      createdAt: new Date().toISOString(),
      metadata: listResult.status === 'success' ? listResult.metadata : null,
      preview: listResult.status === 'success' ? (listResult as any).preview : null,
      links:
        listResult.status === 'success' && listResult.links
          ? listResult.links.map((l: any) => ({
              ...l,
              status: 'processing',
              logs: [{ msg: '🔍 Queued for processing...', type: 'info' }],
            }))
          : [],
    };

    const taskRef = await db.collection('scraping_tasks').add(taskData);
    const taskId = taskRef.id;

    if (listResult.status === 'success' && listResult.links) {
      runBackgroundSolving(taskId, listResult.links, trimmedUrl).catch((err) =>
        console.error('[BG Solve New] Error:', err.message)
      );
    } else if (listResult.status === 'success') {
      await taskRef.update({ status: 'failed', error: 'No links found on page' });
    } else {
      await taskRef.update({
        status: 'failed',
        error: listResult.message || 'Extraction failed',
      });
      sendTelegramAlert(trimmedUrl, listResult.message || 'Extraction failed').catch(() => {});
    }

    return NextResponse.json({
      taskId,
      metadata: taskData.metadata,
      preview: taskData.preview,
    });
  } catch (e: any) {
    console.error('[POST /api/tasks] Unhandled error:', e.message, e.stack);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// =============================================
// Background solving pipeline
// =============================================
async function runBackgroundSolving(
  taskId: string,
  links: any[],
  sourceUrl: string,
  startIdx: number = 0
) {
  const taskRef = db.collection('scraping_tasks').doc(taskId);

  try {
    const solvedLinks = await Promise.all(
      links.map(async (linkData: any) => {
        let currentLink = linkData.link;
        const logs: { msg: string; type: string }[] = [];

        const addLog = (msg: string, type: string = 'info') => {
          logs.push({ msg, type });
        };

        const fetchWithUA = (url: string) =>
          fetch(url, {
            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
          });

        try {
          addLog('🔍 Analyzing Link...', 'info');

          // --- HubCDN Bypass ---
          if (currentLink.includes('hubcdn.fans')) {
            addLog('⚡ HubCDN Detected! Processing...', 'info');
            const r = await solveHubCDN(currentLink);
            if (r.status === 'success') {
              addLog('🎉 Direct Link Found!', 'success');
              return { ...linkData, finalLink: r.final_link, status: 'done', logs };
            } else {
              addLog(`❌ HubCDN Error: ${r.message}`, 'error');
              return { ...linkData, status: 'error', error: r.message, logs };
            }
          }

          // --- Timer Bypass ---
          const targetDomains = ['hblinks', 'hubdrive', 'hubcdn', 'hubcloud'];
          let loopCount = 0;
          while (loopCount < 3 && !targetDomains.some((d) => currentLink.includes(d))) {
            const isTimerPage = ['gadgetsweb', 'review-tech', 'ngwin', 'cryptoinsights'].some((x) =>
              currentLink.includes(x)
            );
            if (!isTimerPage && loopCount === 0) break;

            addLog('⏳ Timer Detected. Bypassing...', 'warn');
            try {
              const r = await fetchWithUA(
                API_MAP.timer + encodeURIComponent(currentLink)
              ).then((res) => res.json());
              if (r.status === 'success') {
                currentLink = r.extracted_link!;
                addLog('✅ Timer Bypassed', 'success');
              } else {
                addLog(`❌ Timer Error: ${r.message || 'Failed'}`, 'error');
                break;
              }
            } catch (e: any) {
              addLog(`❌ Timer Error: ${e.message}`, 'error');
              break;
            }
            loopCount++;
          }

          // --- HBLinks ---
          if (currentLink.includes('hblinks')) {
            addLog('🔗 Solving HBLinks...', 'info');
            const r = await solveHBLinks(currentLink);
            if (r.status === 'success') {
              currentLink = r.link!;
              addLog('✅ HBLinks Solved', 'success');
            } else {
              addLog(`❌ HBLinks Error: ${r.message}`, 'error');
              return { ...linkData, status: 'error', error: r.message, logs };
            }
          }

          // --- HubDrive ---
          if (currentLink.includes('hubdrive')) {
            addLog('☁️ Solving HubDrive...', 'info');
            const r = await solveHubDrive(currentLink);
            if (r.status === 'success') {
              currentLink = r.link!;
              addLog('✅ HubDrive Solved', 'success');
            } else {
              addLog(`❌ HubDrive Error: ${r.message}`, 'error');
              return { ...linkData, status: 'error', error: r.message, logs };
            }
          }

          // --- Final HubCloud ---
          if (currentLink.includes('hubcloud') || currentLink.includes('hubcdn')) {
            addLog('⚡ Getting Direct Link...', 'info');
            try {
              const r = await fetchWithUA(
                API_MAP.hubcloud + encodeURIComponent(currentLink)
              ).then((res) => res.json());
              if (r.status === 'success') {
                addLog('🎉 COMPLETED - Link Extracted!', 'success');
                return { ...linkData, finalLink: r.link, status: 'done', logs };
              } else {
                addLog('❌ HubCloud API Failed', 'error');
              }
            } catch (e: any) {
              addLog(`❌ HubCloud Error: ${e.message}`, 'error');
            }
          }

          addLog('❌ Could not extract final link', 'error');
          return { ...linkData, status: 'error', error: 'Could not solve', logs };
        } catch (e: any) {
          addLog(`⚠️ Critical Error: ${e.message}`, 'error');
          return { ...linkData, status: 'error', error: e.message, logs };
        }
      })
    );

    // Persist to Firebase
    if (startIdx > 0) {
      const currentDoc = await taskRef.get();
      const currentData = currentDoc.data();
      if (currentData) {
        const existingLinks = currentData.links || [];
        const mergedLinks = [...existingLinks.slice(0, startIdx), ...solvedLinks];
        await taskRef.update({
          status: 'completed',
          links: mergedLinks,
          completedAt: new Date().toISOString(),
        });
      }
    } else {
      await taskRef.update({
        status: 'completed',
        links: solvedLinks,
        completedAt: new Date().toISOString(),
      });
    }
  } catch (e: any) {
    console.error(`[BackgroundSolving] Pipeline error for task ${taskId}:`, e.message);

    try {
      await taskRef.update({
        status: 'failed',
        error: e.message,
        failedAt: new Date().toISOString(),
      });
    } catch (_) {
      console.error('[BackgroundSolving] Could not update task status to failed');
    }

    sendTelegramAlert(sourceUrl, e.message).catch(() => {});
  }
}
