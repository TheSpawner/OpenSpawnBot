import * as mouth from '../mouth.mjs';
import * as P from '../os/platform.mjs';

const brief = (text, n = 900) => text.length > n ? text.slice(0, n) + ' …' : text;
export const extraTools = [
  {
    id: 'research', title: 'Research', family: 'AI', risk: 'read',
    description: 'Find something out on the web and get a cross-checked, verified answer with sources: the latest news or release of something, a fact, an explanation, a comparison.',
    examples: ['search the web for the latest release of a program', 'find out who won the match last night', 'look up the current price of something', 'research the best laptops under 1000 dollars', 'find out what the reviews say about a product'],
    parameters: { type: 'object', properties: { question: { type: 'string', description: 'the question to research, as a full question' } }, required: ['question'] },
    async run({ question }, ctx) {
      const { answer } = await import('../brain.mjs');
      const r = await answer({ prompt: question || ctx.step, mode: 'research', history: [] }, { emit: () => {}, signal: ctx.signal });
      return { answer: r.answer, sources: (r.sources || []).slice(0, 5).map(s => `${s.title} — ${s.url}`) };
    }
  },
  {
    id: 'write_text', title: 'Write text', family: 'AI', risk: 'read',
    description: 'Write, summarise, translate, rewrite or draft text — an email, a summary of earlier results, a letter, a list, a document body — using the results of earlier steps.',
    examples: ['write a short summary of those results', 'draft an email to my landlord', 'translate it into Spanish', 'write the content of the report'],
    parameters: { type: 'object', properties: { instruction: { type: 'string', description: 'what to write' } }, required: ['instruction'] },
    async run({ instruction }, ctx) {
      let material = (ctx.results || []).filter(r => r.ok).map((r, i) => `[${i + 1}] ${r.step}:\n${brief(r.output, 2500)}`).join('\n\n');
      const asked = `${instruction} ${ctx.goal || ''}`;
      const creative = /\b(poem|story|stories|song|lyrics|joke|haiku|limerick|slogan|tagline|fiction|fairy tale|rap|verse|bedtime|toast|pickup line)\b/i.test(asked);
      const factual = /\b(article|summary|report|essay|bio|biography|profile|overview|explainer|blog post|post|piece|fact sheet|briefing|history of|guide)\b/i.test(asked);
      if (!material && factual && !creative) {
        const topic = (asked.match(/\b(?:about|on|of|regarding|covering)\s+([^.,;:!?()]+?)(?:\s+(?:and|then|to|in|into|inside|as a|and save)\b|[.,;:!?(]|$)/i)?.[1] || instruction).trim();
        const research = extraTools.find(t => t.id === 'research');
        const found = await research.run({ question: `Who or what is ${topic}, and what are the most important recent facts about it?` }, ctx).catch(() => null);
        if (found?.answer) material = `[research] ${topic}:\n${brief(found.answer, 3000)}`;
      }
      const { text } = await mouth.say([
        { role: 'system', content: 'You write clear, useful text exactly as asked. Use only facts from the material provided; do not invent facts. Output only the text itself.' },
        { role: 'user', content: `${material ? `MATERIAL:\n${material}\n\n` : ''}Request: ${ctx.goal}\nWrite: ${instruction}` }
      ], { maxTokens: 700, temperature: 0.4, signal: ctx.signal });
      return { text: text.trim() };
    }
  },
  {
    id: 'system_status', title: 'System status', family: 'System', risk: 'read',
    description: 'Live status of this computer: operating system, CPU, memory use, disk space on every drive, uptime and the programs using the most memory.',
    examples: ['check the free space left on each drive', 'what program is using all my memory', 'how much RAM is free', 'which running apps use the most memory', 'computer specs and uptime'],
    parameters: { type: 'object', properties: {} },
    async run() {
      const os = await import('node:os');
      const gb = n => `${(n / 1024 ** 3).toFixed(1)} GB`;
      const [disks, procs] = await Promise.all([P.disks(), P.processes()]);
      return {
        system: `${P.OS_NAME} ${os.release()} on ${os.cpus()[0]?.model?.trim()} (${os.cpus().length} threads)`,
        memory: `${gb(os.totalmem() - os.freemem())} used of ${gb(os.totalmem())}`,
        uptime: `${(os.uptime() / 3600).toFixed(1)} hours`,
        disks: disks.map(d => `${d.mount} ${gb(d.free)} free of ${gb(d.size)}`),
        topMemory: (Array.isArray(procs) ? procs : [procs]).slice(0, 10).map(p => `${p.name}${p.count > 1 ? ` ×${p.count}` : ''} ${gb(p.mem)}`)
      };
    }
  },
  {
    id: 'find_files', title: 'Find files', family: 'Files', risk: 'read',
    description: 'Find files on this computer by name, type, folder and age, sorted by size (biggest first) or by date (newest first). Searches the personal folders unless a folder is given.',
    examples: ['find the biggest files in my downloads folder', 'what is taking up space in documents', 'find PDFs I downloaded this week', 'where is my resume', 'find all photos from last month', 'list the newest files on my desktop', 'search my computer for files about taxes'],
    parameters: { type: 'object', properties: {
      folder: { type: 'string', description: 'folder to search: desktop, documents, downloads, pictures, music, videos, a full path, or empty for all personal folders' },
      nameContains: { type: 'string', description: 'words that must be in the file name, or empty' },
      extensions: { type: 'string', description: 'file types separated by commas, like "pdf" or "jpg,png", or empty' },
      changedWithinDays: { type: 'number', description: 'only files changed in the last N days, or 0 for any time' },
      sortBy: { enum: ['size', 'newest', 'name'] }
    }, required: ['folder', 'sortBy'] },
    async run({ folder = '', nameContains = '', extensions = '', changedWithinDays = 0, sortBy = 'size' }) {
      const fs = await import('node:fs');
      const { join, basename } = await import('node:path');
      const f = await P.folders();
      const roots = folder ? [await P.resolvePath(folder)] : [f.desktop, f.documents, f.downloads, f.pictures, f.videos, f.music];
      const exts = String(extensions).toLowerCase().split(/[,\s]+/).map(e => e.replace(/^\./, '')).filter(Boolean);
      let words = String(nameContains).toLowerCase().split(/[\s,]+/).filter(w => w && !/^(largest|biggest|big|huge|file|files|the|my|all|any|newest|latest|recent|oldest|in|of|folder|downloads?|documents?|desktop|size|sized)$/.test(w));
      const since = Number(changedWithinDays) > 0 ? Date.now() - Number(changedWithinDays) * 86400000 : 0;
      let hits = [], note = null, seen = 0;
      const scan = () => {
      hits = []; seen = 0;
      const until = Date.now() + 5000;
      const stack = [...roots];
      while (stack.length && Date.now() < until) {
        const dir = stack.pop(); let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          const full = join(dir, e.name); seen++;
          if (e.isDirectory()) { if (!/^(node_modules|\.git|AppData|\$Recycle\.Bin|Library|\.cache|\.venv)$/.test(e.name) && !e.name.startsWith('.')) stack.push(full); continue; }
          if (!e.isFile()) continue;
          const name = e.name.toLowerCase();
          if (exts.length && !exts.some(x => name.endsWith('.' + x))) continue;
          if (words.length && !words.every(w => name.includes(w))) continue;
          let st; try { st = fs.statSync(full); } catch { continue; }
          if (since && st.mtimeMs < since) continue;
          hits.push({ path: full, name: e.name, size: st.size, modified: st.mtimeMs });
        }
      }
      };
      scan();
      if (!hits.length && words.length) { note = `no file names contain "${words.join(' ')}"; showing all files instead`; words = []; scan(); }
      hits.sort(sortBy === 'newest' ? (a, b) => b.modified - a.modified : sortBy === 'name' ? (a, b) => a.name.localeCompare(b.name) : (a, b) => b.size - a.size);
      const human = n => n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
      return {
        searched: roots.join(', '), filesChecked: seen, matches: hits.length, sortedBy: sortBy, ...(note ? { note } : {}),
        files: hits.slice(0, 15).map(h => `${h.name} — ${human(h.size)} — ${new Date(h.modified).toISOString().slice(0, 10)} — ${h.path}`)
      };
    }
  }
];
