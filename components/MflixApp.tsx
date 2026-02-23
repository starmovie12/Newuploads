'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Bolt, Link as LinkIcon, Rocket, Loader2, RotateCcw, AlertTriangle, CircleCheck, History, ChevronRight, ChevronDown, Video, Film, Globe, Volume2, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import LinkCard from '@/components/LinkCard';

interface LogEntry {
  msg: string;
  type: 'info' | 'success' | 'error' | 'warn';
}

interface Task {
  id: string;
  url: string;
  status: 'processing' | 'completed' | 'failed';
  createdAt: string;
  links: any[];
  error?: string;
  preview?: {
    title: string;
    posterUrl: string | null;
  };
  metadata?: {
    quality: string;
    languages: string;
    audioLabel: string;
  };
}

export default function MflixApp() {
  const [url, setUrl] = useState('');
  const [isConnecting, setIsConnecting] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDone, setIsDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);

  // Live stream state
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [liveLogs, setLiveLogs] = useState<Record<number, LogEntry[]>>({});
  const [liveLinks, setLiveLinks] = useState<Record<number, string | null>>({});
  const [liveStatuses, setLiveStatuses] = useState<Record<number, string>>({});

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetchTasks();
    pollRef.current = setInterval(fetchTasks, 10000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  const fetchTasks = async () => {
    try {
      const res = await fetch('/api/tasks');
      if (!res.ok) {
        const text = await res.text();
        if (text.includes("Rate exceeded")) return;
        throw new Error(`Server error: ${res.status}`);
      }
      const contentType = res.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) return;
      const data = await res.json();
      if (Array.isArray(data)) {
        setTasks(data);
      }
    } catch (e) {
      console.error('Failed to fetch tasks:', e);
    }
  };

  /**
   * Stream the solving process in real-time via SSE (NDJSON)
   */
  const startLiveStream = useCallback(async (taskId: string, links: any[]) => {
    setActiveTaskId(taskId);
    
    // Initialize live state for each link
    const initialLogs: Record<number, LogEntry[]> = {};
    const initialLinks: Record<number, string | null> = {};
    const initialStatuses: Record<number, string> = {};
    
    links.forEach((_: any, idx: number) => {
      initialLogs[idx] = [];
      initialLinks[idx] = null;
      initialStatuses[idx] = 'processing';
    });
    
    setLiveLogs(initialLogs);
    setLiveLinks(initialLinks);
    setLiveStatuses(initialStatuses);

    try {
      const response = await fetch('/api/stream_solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          links: links.map((l: any, idx: number) => ({ ...l, id: idx })),
          taskId
        })
      });

      if (!response.body) return;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            const lid = data.id;

            if (data.msg && data.type) {
              // Log message
              setLiveLogs(prev => ({
                ...prev,
                [lid]: [...(prev[lid] || []), { msg: data.msg, type: data.type }]
              }));
            }

            if (data.final) {
              // Final link found
              setLiveLinks(prev => ({ ...prev, [lid]: data.final }));
            }

            if (data.status === 'done' || data.status === 'error' || data.status === 'finished') {
              setLiveStatuses(prev => ({
                ...prev,
                [lid]: data.status === 'finished' ? (prev[lid] === 'done' ? 'done' : 'error') : data.status
              }));
            }
          } catch {
            // skip invalid JSON lines
          }
        }
      }
    } catch (e: any) {
      console.error('Stream error:', e);
    }

    // Refresh tasks from Firebase after stream ends
    setTimeout(fetchTasks, 2000);
    setActiveTaskId(null);
  }, []);

  const startProcess = async () => {
    if (!url.trim()) {
      if (navigator.vibrate) navigator.vibrate(50);
      return;
    }

    setIsConnecting(true);
    setError(null);
    setIsDone(false);

    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim() })
      });

      if (!response.ok) {
        const text = await response.text();
        if (text.includes("Rate exceeded")) {
          throw new Error("Server is busy (Rate Limit). Please wait a few seconds and try again.");
        }
        throw new Error(`Server error: ${response.status}`);
      }

      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        throw new Error("Received unexpected response format from server.");
      }

      const data = await response.json();
      if (data.error) throw new Error(data.error);

      setIsConnecting(false);
      setIsProcessing(true);

      // Fetch updated task list to get the new task
      await fetchTasks();

      // Auto-expand the new task
      if (data.taskId) {
        setExpandedTask(data.taskId);

        // If it's a new task (not just merged with 0 new links), start live stream
        if (!data.merged || data.newLinksAdded > 0) {
          // Get the links from the freshly created task
          const taskRes = await fetch('/api/tasks');
          const taskList = await taskRes.json();
          const newTask = taskList.find((t: any) => t.id === data.taskId);
          
          if (newTask && newTask.links && newTask.links.length > 0) {
            // Start live stream for real-time logs
            startLiveStream(data.taskId, newTask.links);
          }
        }
      }

      setUrl('');
      setIsProcessing(false);
      setIsDone(true);
      setTimeout(() => setIsDone(false), 3000);

    } catch (err: any) {
      console.error(err);
      setError(err.message || 'An error occurred');
      setIsConnecting(false);
      setIsProcessing(false);
    }
  };

  /**
   * Get effective logs/links/statuses: prefer live data if streaming, else use Firebase data
   */
  const getEffectiveLinkData = (task: Task, linkIdx: number, link: any) => {
    const isLive = activeTaskId === task.id;
    return {
      logs: isLive ? (liveLogs[linkIdx] || []) : (link.logs || []),
      finalLink: isLive ? (liveLinks[linkIdx] || link.finalLink || null) : (link.finalLink || null),
      status: isLive ? (liveStatuses[linkIdx] || 'processing') : (link.status || 'done'),
    };
  };

  return (
    <div className="max-w-2xl mx-auto px-4 py-8">
      {/* Header */}
      <header className="flex justify-between items-center mb-8">
        <div className="text-2xl font-bold bg-gradient-to-br from-white to-slate-400 bg-clip-text text-transparent flex items-center gap-2">
          <Bolt className="text-indigo-500 fill-indigo-500" />
          MFLIX PRO
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-slate-500 font-mono">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          LIVE ENGINE
        </div>
      </header>

      {/* Input Section */}
      <section className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-[2rem] p-6 mb-8 shadow-2xl">
        <div className="relative mb-4">
          <LinkIcon className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500 w-5 h-5" />
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && startProcess()}
            placeholder="Paste Movie URL here..."
            className="w-full bg-black/40 border border-white/10 text-white pl-12 pr-4 py-4 rounded-2xl outline-none focus:border-indigo-500 focus:ring-4 focus:ring-indigo-500/20 transition-all font-sans"
          />
        </div>

        <button
          onClick={startProcess}
          disabled={isConnecting || isProcessing || isDone}
          className={`w-full py-4 rounded-2xl font-bold text-lg flex items-center justify-center gap-3 transition-all duration-300 shadow-lg active:scale-95 ${
            isDone 
              ? 'bg-emerald-500 text-white' 
              : error 
                ? 'bg-rose-500 text-white'
                : 'bg-indigo-600 hover:bg-indigo-500 text-white disabled:bg-slate-800 disabled:opacity-70'
          }`}
        >
          {isConnecting ? (
            <>
              <Loader2 className="w-5 h-5 animate-spin" />
              CONNECTING...
            </>
          ) : isProcessing ? (
            <>
              <RotateCcw className="w-5 h-5 animate-spin" />
              PROCESSING LIVE...
            </>
          ) : isDone ? (
            <>
              <CircleCheck className="w-5 h-5" />
              ALL DONE ✅
            </>
          ) : error ? (
            <>
              <AlertTriangle className="w-5 h-5" />
              ERROR - RETRY
            </>
          ) : (
            <>
              START ENGINE
              <Rocket className="w-5 h-5" />
            </>
          )}
        </button>

        {error && (
          <motion.div 
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mt-4 p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 text-sm flex items-center gap-3"
          >
            <AlertTriangle className="w-5 h-5 flex-shrink-0" />
            <p className="flex-1">{error}</p>
            <button onClick={() => setError(null)} className="text-xs font-bold uppercase hover:text-rose-300">Dismiss</button>
          </motion.div>
        )}
      </section>

      {/* Tasks List */}
      <div className="mb-6 flex items-center gap-2 text-slate-400">
        <History className="w-5 h-5" />
        <h3 className="font-bold uppercase tracking-wider text-sm">Recent Tasks</h3>
      </div>

      <div className="space-y-4">
        {tasks.map((task) => (
          <div key={task.id} className="bg-white/5 backdrop-blur-xl border border-white/10 rounded-2xl overflow-hidden transition-all hover:bg-white/[0.07]">
            <div 
              className="p-4 flex items-center gap-4 cursor-pointer"
              onClick={() => setExpandedTask(expandedTask === task.id ? null : task.id)}
            >
              {/* Movie Poster Thumbnail */}
              <div className="w-12 h-16 bg-slate-800 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden border border-white/10">
                {task.preview?.posterUrl ? (
                  <img 
                    src={task.preview.posterUrl} 
                    alt={task.preview?.title || 'Movie'}
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                      (e.target as HTMLImageElement).nextElementSibling?.classList.remove('hidden');
                    }}
                  />
                ) : null}
                <Film className={`w-5 h-5 text-indigo-400 ${task.preview?.posterUrl ? 'hidden' : ''}`} />
              </div>
              
              <div className="flex-1 min-w-0">
                {/* Movie Title */}
                <h4 className="font-bold text-sm text-white truncate">
                  {task.preview?.title || 'Processing...'}
                </h4>
                <p className="font-mono text-[10px] text-slate-500 truncate mt-0.5">{task.url}</p>
                <div className="flex items-center gap-3 mt-1.5">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase ${
                    task.status === 'completed' ? 'bg-emerald-500/20 text-emerald-400' :
                    task.status === 'failed' ? 'bg-rose-500/20 text-rose-400' :
                    'bg-indigo-500/20 text-indigo-400 animate-pulse'
                  }`}>
                    {task.status === 'processing' && activeTaskId === task.id ? '⚡ LIVE' : task.status}
                  </span>
                  <span className="text-slate-600 text-[10px]">{new Date(task.createdAt).toLocaleString()}</span>
                  {task.links?.length > 0 && (
                    <span className="text-slate-500 text-[10px]">{task.links.length} links</span>
                  )}
                </div>
              </div>

              {expandedTask === task.id ? <ChevronDown className="w-5 h-5 text-slate-500" /> : <ChevronRight className="w-5 h-5 text-slate-500" />}
            </div>

            <AnimatePresence>
              {expandedTask === task.id && (
                <motion.div 
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="border-t border-white/5 bg-black/20"
                >
                  {/* Movie Preview Banner */}
                  {task.preview?.posterUrl && (
                    <div className="relative h-32 overflow-hidden">
                      <img 
                        src={task.preview.posterUrl}
                        alt={task.preview?.title || ''}
                        className="w-full h-full object-cover opacity-30 blur-sm"
                      />
                      <div className="absolute inset-0 bg-gradient-to-t from-black/90 to-transparent" />
                      <div className="absolute bottom-3 left-4 right-4">
                        <h3 className="text-lg font-bold text-white truncate">{task.preview?.title}</h3>
                      </div>
                    </div>
                  )}

                  <div className="p-4">
                    {/* Metadata Boxes */}
                    {task.metadata && (
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
                        <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                          <label className="text-[10px] uppercase font-bold text-slate-500 flex items-center gap-1 mb-1.5">
                            <Sparkles className="w-3 h-3" />
                            Highest Quality
                          </label>
                          <p className="text-sm font-bold text-indigo-400">{task.metadata.quality || 'Unknown'}</p>
                        </div>
                        <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                          <label className="text-[10px] uppercase font-bold text-slate-500 flex items-center gap-1 mb-1.5">
                            <Globe className="w-3 h-3" />
                            Languages
                          </label>
                          <p className="text-sm font-bold text-emerald-400">{task.metadata.languages || 'Not Specified'}</p>
                        </div>
                        <div className="bg-white/5 border border-white/10 rounded-xl p-3">
                          <label className="text-[10px] uppercase font-bold text-slate-500 flex items-center gap-1 mb-1.5">
                            <Volume2 className="w-3 h-3" />
                            Audio Label
                          </label>
                          <p className="text-sm font-bold text-amber-400">{task.metadata.audioLabel || 'Unknown'}</p>
                        </div>
                      </div>
                    )}

                    {/* Processing State with Live Logs */}
                    {(task.status === 'processing' || activeTaskId === task.id) && (
                      <div className="space-y-3">
                        {task.links.map((link: any, idx: number) => {
                          const effective = getEffectiveLinkData(task, idx, link);
                          return (
                            <LinkCard
                              key={idx}
                              id={idx}
                              name={link.name}
                              logs={effective.logs}
                              finalLink={effective.finalLink}
                              status={effective.status as any}
                            />
                          );
                        })}
                        {task.links.length === 0 && (
                          <div className="flex flex-col items-center py-8 text-slate-400">
                            <Loader2 className="w-8 h-8 animate-spin mb-2" />
                            <p className="text-sm">Scraping in progress...</p>
                            <p className="text-xs opacity-50">You can close this window and return later.</p>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Failed State */}
                    {task.status === 'failed' && activeTaskId !== task.id && (
                      <div className="p-4 bg-rose-500/10 border border-rose-500/20 rounded-xl text-rose-400 text-sm">
                        <AlertTriangle className="w-5 h-5 mb-2" />
                        {task.error || 'Task failed unexpectedly.'}
                      </div>
                    )}

                    {/* Completed State */}
                    {task.status === 'completed' && activeTaskId !== task.id && (
                      <div className="space-y-3">
                        {task.links.map((link: any, idx: number) => (
                          <LinkCard
                            key={idx}
                            id={idx}
                            name={link.name}
                            logs={link.logs || []}
                            finalLink={link.finalLink || null}
                            status={link.status || 'done'}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        ))}

        {tasks.length === 0 && (
          <div className="text-center py-12 text-slate-500 border-2 border-dashed border-white/5 rounded-3xl">
            <Rocket className="w-12 h-12 mx-auto mb-4 opacity-20" />
            <p>No tasks yet. Submit a URL to start!</p>
          </div>
        )}
      </div>
    </div>
  );
}
