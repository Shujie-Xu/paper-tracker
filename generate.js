#!/usr/bin/env node
/**
 * paper-tracker · generate.js (Quarto website edition)
 * papers-db.json → index.qmd + papers/{id}.qmd → quarto render → docs/
 * Usage: node generate.js [--push]
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DB_FILE    = path.join(__dirname, 'papers-db.json');
const PAPERS_DIR = path.join(__dirname, 'papers');
const OUT_DIR    = path.join(__dirname, 'docs');

// ── Load papers ────────────────────────────────────────────────
const allPapers = fs.existsSync(DB_FILE)
  ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
  : [];

allPapers.sort((a, b) => (b.relevance_score || 0) - (a.relevance_score || 0) ||
                          (b.date || '').localeCompare(a.date || ''));

// ── Shared CSS (injected into every .qmd via include-in-header) ─
const CUSTOM_CSS = `<style>
body { font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
h1,h2,h3,h4,h5 { font-family: "Georgia", "Times New Roman", serif; }
a { color: #2c6fad; }

/* Stats bar */
.tracker-stats { display:flex; flex-wrap:wrap; gap:1.25rem; padding:0.75rem 1rem;
  background:#f8f9fa; border-radius:6px; margin-bottom:1.25rem; font-size:0.85rem; color:#495057; }
.tracker-stats strong { color:#212529; }

/* Filter bar */
.filter-bar { display:flex; flex-wrap:wrap; gap:0.4rem; margin-bottom:1.5rem; align-items:center; }
.filter-label { font-size:0.78rem; color:#6c757d; font-style:italic; margin-right:0.25rem; }
.filter-btn { font-size:0.78rem; padding:0.2rem 0.65rem; border-radius:20px;
  border:1px solid #dee2e6; background:white; color:#495057; cursor:pointer; transition:all .15s; }
.filter-btn:hover, .filter-btn.active { background:#2c6fad; border-color:#2c6fad; color:white; }

/* Paper card */
.paper-card { border:1px solid #dee2e6; border-radius:8px; padding:1rem 1.2rem;
  margin-bottom:0.85rem; background:white; transition:box-shadow .15s, border-color .15s; }
.paper-card:hover { box-shadow:0 2px 8px rgba(0,0,0,.08); border-color:#adb5bd; }
.paper-card.top-pick { border-left:4px solid #d4380d; }
.paper-card.high-relevance { border-left:4px solid #fa8c16; }
.paper-card.hidden { display:none !important; }

.paper-title { font-size:0.96rem; font-weight:600; font-family:Georgia,serif;
  margin-bottom:0.3rem; line-height:1.4; }
.paper-title a { color:inherit; text-decoration:none; }
.paper-title a:hover { color:#2c6fad; text-decoration:underline; }

.paper-meta { display:flex; flex-wrap:wrap; gap:0.35rem; align-items:center;
  margin-bottom:0.4rem; font-size:0.78rem; }
.paper-authors { font-size:0.8rem; color:#6c757d; font-style:italic; margin-bottom:0.35rem; }

/* Badges */
.score-badge { font-weight:700; padding:0.1rem 0.4rem; border-radius:4px; font-size:0.75rem; }
.score-top    { background:#fff1f0; color:#d4380d; }
.score-high   { background:#fff7e6; color:#d46b08; }
.score-mid    { background:#f6ffed; color:#389e0d; }
.score-low    { background:#f5f5f5; color:#595959; }
.topic-tag  { font-size:0.72rem; padding:0.1rem 0.45rem; border-radius:20px;
  background:#e8f4fd; color:#2c6fad; }
.source-tag { font-size:0.72rem; padding:0.1rem 0.45rem; border-radius:20px;
  background:#f0f0f0; color:#595959; }

/* Analysis (detail pages) */
.analysis-block { margin-top:0.75rem; padding-top:0.75rem;
  border-top:1px solid #e9ecef; font-size:0.83rem; }
.analysis-grid { display:grid; grid-template-columns:1fr 1fr; gap:0.5rem 1.2rem; margin-bottom:0.5rem; }
.analysis-item label { display:block; font-size:0.72rem; font-weight:600;
  text-transform:uppercase; letter-spacing:.04em; color:#6c757d; margin-bottom:.15rem; }
.analysis-item p { color:#212529; margin:0; }
.takeaway-box { background:#fff8e6; border-left:3px solid #fa8c16;
  border-radius:0 4px 4px 0; padding:0.5rem 0.75rem; color:#333; }
.takeaway-box strong { color:#d46b08; }

@media(max-width:768px) { .analysis-grid { grid-template-columns:1fr; } }
</style>`;

// ── Helpers ────────────────────────────────────────────────────
function esc(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function md(s) { return (s || '').replace(/[*_`#\[\]]/g, '\\$&'); }

function scoreClass(s) {
  if (s >= 8.5) return 'top';
  if (s >= 7)   return 'high';
  if (s >= 5)   return 'mid';
  return 'low';
}
function cardClass(s) {
  if (s >= 8.5) return ' top-pick';
  if (s >= 7)   return ' high-relevance';
  return '';
}
function topicLabel(t) {
  return ({
    'information':        'Information Econ',
    'corporate-political':'Corp. Political',
    'text-methods':       'Text Methods',
    'causal-inference':   'Causal Inference',
    'corporate-finance':  'Corp. Finance',
    'supply-chain':       'Supply Chain',
  })[t] || t;
}

function getISOWeek(dateStr) {
  const d = new Date((dateStr || '2026-01-01') + 'T00:00:00Z');
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const dow  = jan4.getUTCDay() || 7;
  const ws   = new Date(jan4.getTime() - (dow - 1) * 86400000);
  return `${d.getUTCFullYear()}-W${String(1 + Math.floor((d - ws) / (7 * 86400000))).padStart(2,'0')}`;
}
function weekLabel(weekStr) {
  const [year, wPart] = weekStr.split('-W');
  const w = parseInt(wPart, 10);
  const jan4 = new Date(Date.UTC(+year, 0, 4));
  const dow  = jan4.getUTCDay() || 7;
  const mon  = new Date(jan4.getTime() - (dow - 1) * 86400000 + (w - 1) * 7 * 86400000);
  const sun  = new Date(mon.getTime() + 6 * 86400000);
  const M    = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `Week ${w} · ${M[mon.getUTCMonth()]} ${mon.getUTCDate()}–${sun.getUTCDate()}, ${year}`;
}

// ── Decide which papers get internal pages ─────────────────────
// Internal page: AI-scored papers (score >= 5.0) or any with full analysis
const papersWithPage = allPapers.filter(p =>
  (p.relevance_score || 0) >= 5.0 || p.status === 'full_read' || p.status === 'scored'
);
const pageSet = new Set(papersWithPage.map(p => p.id));

// ── Generate individual paper .qmd files ───────────────────────
if (!fs.existsSync(PAPERS_DIR)) fs.mkdirSync(PAPERS_DIR, { recursive: true });

// Clean stale paper qmds first
fs.readdirSync(PAPERS_DIR).filter(f => f.endsWith('.qmd')).forEach(f =>
  fs.unlinkSync(path.join(PAPERS_DIR, f))
);

for (const p of papersWithPage) {
  const score   = p.relevance_score || 0;
  const sc      = scoreClass(score);
  const authors = (p.authors || []).join(', ');
  const topics  = (p.topics || []).map(t =>
    `<span class="topic-tag">${topicLabel(t)}</span>`).join(' ');

  // ── Analysis section ──────────────────────────────────────
  let analysisSection = '';
  if (p.analysis) {
    const a = p.analysis;
    const field = (label, val) => val ? `
### ${label}
${val}
` : '';
    analysisSection = `
---

## Analysis

${field('Research Question', a.research_question)}
${field('Data', a.data)}
${field('Identification Strategy', a.identification)}
${field('Main Findings', a.main_findings)}
${field('Limitations', a.limitations)}

---

### Connection to Current Research

${a.connection_to_my_work || ''}

::: {.callout-tip}
## Key Takeaway
${a.my_takeaway || ''}
:::
`;
  } else {
    analysisSection = `
---

::: {.callout-note}
## Analysis Pending
This paper has been relevance-scored (${score.toFixed(1)}/10).
${score >= 7.5
  ? 'Deep PDF analysis is queued and will appear after the next weekly run.'
  : 'Full analysis is generated for papers scoring ≥ 7.5.'}
:::
`;
  }

  const qmd = `---
title: "${md(p.title)}"
format:
  html:
    toc: true
    toc-location: left
    toc-title: "Sections"
    page-layout: article
---

\`\`\`{=html}
${CUSTOM_CSS}
<div style="margin-bottom:1rem;">
  <a href="../index.html" style="font-size:0.85rem; color:#6c757d; text-decoration:none;">← Back to all papers</a>
</div>
<div style="display:flex; flex-wrap:wrap; gap:0.4rem; align-items:center; margin-bottom:1rem;">
  <span class="score-badge score-${sc}" style="font-size:0.9rem; padding:0.2rem 0.6rem;">${score.toFixed(1)} / 10</span>
  <span class="source-tag">${esc(p.source || 'NBER')}</span>
  ${topics}
</div>
\`\`\`

**Authors:** ${esc(authors) || '—'}

**Published:** ${p.date || '—'} · [View on ${p.source || 'NBER'}](${p.url}){target="_blank"}
${p.pdf_url ? `· [PDF](${p.pdf_url}){target="_blank"}` : ''}

---

## Abstract

${esc(p.abstract || 'Abstract not available.')}

${analysisSection}
`;

  fs.writeFileSync(path.join(PAPERS_DIR, `${p.id}.qmd`), qmd);
}
console.log(`📄 Generated ${papersWithPage.length} paper pages`);

// ── Build index.qmd ────────────────────────────────────────────
const byWeek = new Map();
for (const p of allPapers) {
  const w = p.week || getISOWeek(p.date);
  if (!byWeek.has(w)) byWeek.set(w, []);
  byWeek.get(w).push(p);
}
const weeks = [...byWeek.keys()].sort((a,b) => b.localeCompare(a));

const totalPapers   = allPapers.length;
const nberCount     = allPapers.filter(p => p.source === 'NBER').length;
const ssrnCount     = allPapers.filter(p => p.source === 'SSRN').length;
const fullReadCount = allPapers.filter(p => p.status === 'full_read').length;
const scoredCount   = allPapers.filter(p => (p.relevance_score||0) >= 5).length;
const updateDate    = new Date().toLocaleDateString('en-US',
  { month:'short', day:'numeric', year:'numeric', timeZone:'Asia/Shanghai' });

function paperCard(p) {
  const score   = p.relevance_score || 0;
  const sc      = scoreClass(score);
  const cc      = cardClass(score);
  const hasPage = pageSet.has(p.id);
  const href    = hasPage ? `papers/${p.id}.html` : p.url;
  const target  = hasPage ? '' : ' target="_blank" rel="noopener"';
  const authors = (p.authors || []).slice(0, 3).join(', ')
                + ((p.authors || []).length > 3 ? ' et al.' : '');
  const topicTags = (p.topics || []).slice(0,3).map(t =>
    `<span class="topic-tag" data-topic="${t}">${topicLabel(t)}</span>`).join('');
  const readBadge = p.status === 'full_read'
    ? `<span class="source-tag" style="background:#f6ffed; color:#389e0d;">⭐ Full analysis</span>` : '';

  return `<div class="paper-card${cc}" data-score="${score}" data-source="${p.source||'NBER'}" data-topics="${(p.topics||[]).join(',')}">
  <div class="paper-title">
    <a href="${href}"${target}>${esc(p.title)}</a>
  </div>
  <div class="paper-meta">
    <span class="score-badge score-${sc}">${score.toFixed(1)}</span>
    <span class="source-tag">${p.source||'NBER'}</span>
    ${topicTags}
    ${readBadge}
  </div>
  ${authors ? `<div class="paper-authors">${esc(authors)}</div>` : ''}
</div>`;
}

const weekSections = weeks.map(w => {
  const papers  = byWeek.get(w).sort((a,b) => (b.relevance_score||0) - (a.relevance_score||0));
  const label   = weekLabel(w);
  const anchorId = w.toLowerCase().replace(/[^a-z0-9]+/g,'-');
  return `## ${label} {#${anchorId}}\n\n\`\`\`{=html}\n${papers.map(paperCard).join('\n')}\n\`\`\`\n`;
}).join('\n');

const indexQmd = `---
title: "Research Tracker"
subtitle: "Shujie Xu · Applied Micro & Corporate Finance"
toc: true
toc-location: left
toc-title: "Weeks"
toc-depth: 1
page-layout: full
image: "https://shujie-xu.github.io/paper-tracker/preview.png"
description: "${totalPapers} papers tracked · ${nberCount} NBER · ${ssrnCount > 0 ? ssrnCount + ' SSRN · ' : ''}${weeks.length} weeks · Updated ${updateDate}"
---

\`\`\`{=html}
${CUSTOM_CSS}
<div class="tracker-stats">
  <span class="stat-item">📄 <strong>${totalPapers}</strong> papers tracked</span>
  <span class="stat-item">📅 <strong>${weeks.length}</strong> weeks</span>
  <span class="stat-item">🏛 <strong>${nberCount}</strong> NBER</span>
  ${ssrnCount > 0 ? `<span class="stat-item">📑 <strong>${ssrnCount}</strong> SSRN</span>` : ''}
  ${scoredCount > 0 ? `<span class="stat-item">🎯 <strong>${scoredCount}</strong> AI-scored</span>` : ''}
  ${fullReadCount > 0 ? `<span class="stat-item">⭐ <strong>${fullReadCount}</strong> full reads</span>` : ''}
  <span class="stat-item" style="margin-left:auto; color:#adb5bd; font-size:0.8rem;">Updated ${updateDate}</span>
</div>

<div class="filter-bar" id="filterBar">
  <span class="filter-label">Filter:</span>
  <button class="filter-btn active" onclick="filterCards('all',this)">All</button>
  <button class="filter-btn" onclick="filterCards('full_read',this)">⭐ Full analysis</button>
  <button class="filter-btn" onclick="filterCards('NBER',this)">NBER</button>
  <button class="filter-btn" onclick="filterCards('SSRN',this)">SSRN</button>
  <button class="filter-btn" onclick="filterCards('information',this)">Information</button>
  <button class="filter-btn" onclick="filterCards('corporate-political',this)">Corp. Political</button>
  <button class="filter-btn" onclick="filterCards('text-methods',this)">Text Methods</button>
  <button class="filter-btn" onclick="filterCards('supply-chain',this)">Supply Chain</button>
</div>
\`\`\`

${weekSections}

\`\`\`{=html}
<script>
function filterCards(filter, btn) {
  document.querySelectorAll('#filterBar .filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  document.querySelectorAll('.paper-card').forEach(card => {
    let show = false;
    if (filter === 'all') {
      show = true;
    } else if (filter === 'full_read') {
      show = card.querySelector('.source-tag[style*="f6ffed"]') !== null;
    } else if (filter === 'NBER' || filter === 'SSRN') {
      show = card.dataset.source === filter;
    } else {
      show = (card.dataset.topics || '').split(',').includes(filter);
    }
    card.classList.toggle('hidden', !show);
  });
  document.querySelectorAll('h2').forEach(h2 => {
    const section = h2.closest('section') || h2.parentElement;
    if (!section) return;
    const visible = [...section.querySelectorAll('.paper-card')].some(c => !c.classList.contains('hidden'));
    h2.style.display = visible ? '' : 'none';
  });
}
</script>
\`\`\`
`;

fs.writeFileSync(path.join(__dirname, 'index.qmd'), indexQmd);
console.log(`📝 Written index.qmd (${totalPapers} papers, ${weeks.length} weeks)`);

// ── Quarto render ─────────────────────────────────────────────
// Render index.qmd + all papers/*.qmd individually, then move to docs/
console.log('🔄 Running quarto render...');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

function renderAndMove(qmdPath, destDir) {
  execSync(`cd ${__dirname} && quarto render "${qmdPath}" --quiet`, { stdio: 'inherit' });
  // Output lands in same dir as .qmd — move to destDir
  const htmlPath  = qmdPath.replace(/\.qmd$/, '.html');
  const filesPath = qmdPath.replace(/\.qmd$/, '_files');
  const basename  = path.basename(htmlPath);
  if (fs.existsSync(htmlPath)) {
    fs.renameSync(htmlPath, path.join(destDir, basename));
  }
  if (fs.existsSync(filesPath)) {
    const destFiles = path.join(destDir, path.basename(filesPath));
    if (fs.existsSync(destFiles)) execSync(`rm -rf "${destFiles}"`);
    fs.renameSync(filesPath, destFiles);
  }
}

// Render main index
renderAndMove(path.join(__dirname, 'index.qmd'), OUT_DIR);

// Render paper pages
const papersOutDir = path.join(OUT_DIR, 'papers');
if (!fs.existsSync(papersOutDir)) fs.mkdirSync(papersOutDir, { recursive: true });

const paperQmds = fs.readdirSync(PAPERS_DIR).filter(f => f.endsWith('.qmd'));
for (let i = 0; i < paperQmds.length; i++) {
  const qmdFile = path.join(PAPERS_DIR, paperQmds[i]);
  process.stdout.write(`  Rendering ${i+1}/${paperQmds.length}: ${paperQmds[i]}\r`);
  try {
    renderAndMove(qmdFile, papersOutDir);
  } catch(e) {
    console.warn(`\n  ⚠️ Failed: ${paperQmds[i]}`);
  }
}
if (paperQmds.length > 0) console.log();

// Verify
const outputOk = fs.existsSync(path.join(OUT_DIR, 'index.html'));
console.log(outputOk
  ? `✅ Rendered → docs/\n   ${totalPapers} papers · ${weeks.length} weeks · ${nberCount} NBER · ${ssrnCount} SSRN · ${papersWithPage.length} detail pages`
  : '❌ Render failed: docs/index.html not found');
if (!outputOk) process.exit(1);

// Ensure .nojekyll for GitHub Pages
fs.writeFileSync(path.join(OUT_DIR, '.nojekyll'), '');

// ── Git push ───────────────────────────────────────────────────
if (process.argv.includes('--push')) {
  try {
    const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
    execSync(
      `cd ${__dirname} && git add docs/ index.qmd papers/ _quarto.yml custom.scss generate.js && git commit -m "📚 Paper tracker update ${date}" && git push`,
      { stdio: 'inherit' }
    );
    console.log('🚀 Pushed to GitHub Pages!');
  } catch (e) {
    console.error('⚠️ git push failed:', e.message);
  }
}
