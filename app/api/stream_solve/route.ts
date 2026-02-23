export const maxDuration = 60;

import { db } from '@/lib/firebaseAdmin';
import { solveHBLinks, solveHubCDN, solveHubDrive } from '@/lib/solvers';

const API_MAP = {
  timer: 'https://time-page-bay-pass-edhc.onrender.com/solve?url=',
  hblinks: 'https://hblinks-dad.onrender.com/solve?url=',
  hubdrive: 'https://hdhub4u-1.onrender.com/solve?url=',
  hubcloud: 'http://85.121.5.246:5000/solve?url=',
  hubcdn_bypass: 'https://hubcdn-bypass.onrender.com/extract?url=',
};

export async function POST(req: Request) {
  let links: any[];
  let taskId: string | undefined;

  try {
    const body = await req.json();
    links = body.links;
    taskId = body.taskId;
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!Array.isArray(links) || links.length === 0) {
    return new Response(JSON.stringify({ error: 'No links provided' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (data: any) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(data) + '\n'));
        } catch {
          // Stream may have been closed by client
        }
      };

      const finalResults: Map<number, any> = new Map();

      const processLink = async (linkData: any) => {
        const lid = linkData.id;
        let currentLink = linkData.link;
        const logs: { msg: string; type: string }[] = [];

        const sendLog = (msg: string, type: string = 'info') => {
          logs.push({ msg, type });
          send({ id: lid, msg, type });
        };

        const fetchWithUA = (url: string, options: any = {}) => {
          return fetch(url, {
            ...options,
            headers: {
              ...options.headers,
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
          });
        };

        try {
          sendLog('🔍 Analyzing Link...', 'info');

          // --- HUBCDN.FANS BYPASS ---
          if (currentLink.includes('hubcdn.fans')) {
            sendLog('⚡ HubCDN Detected! Processing...', 'info');
            try {
              const r = await solveHubCDN(currentLink);
              if (r.status === 'success') {
                sendLog('🎉 COMPLETED: Direct Link Found', 'success');
                send({ id: lid, final: r.final_link, status: 'done' });
                finalResults.set(lid, { ...linkData, finalLink: r.final_link, status: 'done', logs });
                return;
              } else throw new Error(r.message || 'HubCDN Native Failed');
            } catch (e: any) {
              sendLog(`❌ HubCDN Error: ${e.message}`, 'error');
              finalResults.set(lid, { ...linkData, status: 'error', error: e.message, logs });
              return;
            }
          }

          // --- TIMER BYPASS ---
          const targetDomains = ['hblinks', 'hubdrive', 'hubcdn', 'hubcloud'];
          let loopCount = 0;

          while (loopCount < 3 && !targetDomains.some((d) => currentLink.includes(d))) {
            const isTimerPage = ['gadgetsweb', 'review-tech', 'ngwin', 'cryptoinsights'].some((x) =>
              currentLink.includes(x)
            );
            if (!isTimerPage && loopCount === 0) break;

            if (loopCount > 0) {
              sendLog('🔄 Bypassing intermediate page: ' + currentLink, 'warn');
            } else {
              sendLog('⏳ Timer Detected. Processing...', 'warn');
            }

            try {
              sendLog('⏳ Calling External Timer API...', 'warn');
              const r = await fetchWithUA(API_MAP.timer + encodeURIComponent(currentLink)).then(
                (res) => res.json()
              );

              if (r.status === 'success') {
                currentLink = r.extracted_link!;
                sendLog('✅ Timer Bypassed', 'success');
                sendLog('🔗 Link after Timer: ' + currentLink, 'info');
              } else {
                throw new Error(r.message || 'External Timer API returned failure status');
              }
            } catch (e: any) {
              sendLog(`❌ Timer Error: ${e.message}`, 'error');
              break;
            }

            loopCount++;
          }

          // --- HBLINKS ---
          if (currentLink.includes('hblinks')) {
            sendLog('🔗 Solving HBLinks (Native)...', 'info');
            try {
              const r = await solveHBLinks(currentLink);
              if (r.status === 'success') {
                currentLink = r.link!;
                sendLog('✅ HBLinks Solved', 'success');
              } else throw new Error(r.message || 'HBLinks Native Failed');
            } catch (e: any) {
              sendLog(`❌ HBLinks Error: ${e.message}`, 'error');
              finalResults.set(lid, { ...linkData, status: 'error', error: e.message, logs });
              return;
            }
          }

          // --- HUBDRIVE ---
          if (currentLink.includes('hubdrive')) {
            sendLog('☁️ Solving HubDrive (Native)...', 'info');
            try {
              const r = await solveHubDrive(currentLink);
              if (r.status === 'success') {
                currentLink = r.link!;
                sendLog('✅ HubDrive Solved', 'success');
                sendLog('🔗 Link after HubDrive: ' + currentLink, 'info');
              } else throw new Error(r.message || 'HubDrive Native Failed');
            } catch (e: any) {
              sendLog(`❌ HubDrive Error: ${e.message}`, 'error');
              finalResults.set(lid, { ...linkData, status: 'error', error: e.message, logs });
              return;
            }
          }

          // --- HUBCLOUD (FINAL) ---
          let finalFound = false;
          if (currentLink.includes('hubcloud') || currentLink.includes('hubcdn')) {
            sendLog('⚡ Getting Direct Link...', 'info');
            try {
              const r = await fetchWithUA(
                API_MAP.hubcloud + encodeURIComponent(currentLink)
              ).then((res) => res.json());
              if (r.status === 'success') {
                sendLog('🎉 COMPLETED', 'success');
                send({ id: lid, final: r.link, status: 'done' });
                finalResults.set(lid, { ...linkData, finalLink: r.link, status: 'done', logs });
                finalFound = true;
              } else throw new Error('HubCloud API Failed');
            } catch (e: any) {
              sendLog(`❌ HubCloud Error: ${e.message}`, 'error');
            }
          }

          // --- FINAL FALLBACK ---
          if (!finalFound) {
            sendLog('❌ Unrecognized link format or stuck', 'error');
            send({ id: lid, status: 'error', msg: 'Process ended without final link' });
            finalResults.set(lid, { ...linkData, status: 'error', error: 'Could not solve', logs });
          }
        } catch (e: any) {
          sendLog(`⚠️ Critical Error: ${e.message}`, 'error');
          finalResults.set(lid, { ...linkData, status: 'error', error: e.message, logs });
        } finally {
          send({ id: lid, status: 'finished' });
        }
      };

      // Process all links concurrently
      await Promise.all(links.map((link: any) => processLink(link)));

      // ===== PERSIST TO FIREBASE =====
      if (taskId) {
        try {
          const taskRef = db.collection('scraping_tasks').doc(taskId);
          const taskDoc = await taskRef.get();
          if (taskDoc.exists) {
            const taskData = taskDoc.data();
            const existingLinks = taskData?.links || [];

            const updatedLinks = existingLinks.map((existingLink: any, idx: number) => {
              const result = finalResults.get(idx);
              if (result) {
                return {
                  ...existingLink,
                  finalLink: result.finalLink || null,
                  status: result.status || 'error',
                  error: result.error || null,
                  logs: result.logs || [],
                };
              }
              return existingLink;
            });

            await taskRef.update({
              status: 'completed',
              links: updatedLinks,
              completedAt: new Date().toISOString(),
            });
          }
        } catch (dbErr: any) {
          console.error('[Stream] Failed to persist to Firebase:', dbErr.message);
        }
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
