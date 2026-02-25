#!/usr/bin/env node
/**
 * paper-tracker · generate.js (Quarto edition)
 * Reads papers-db.json → writes index.qmd → quarto render → docs/index.html
 * Usage: node generate.js [--push]
 */

'use strict';
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DB_FILE  = path.join(__dirname, 'papers-db.json');
const QMD_FILE = path.join(__dirname, 'index.qmd');
const OUT_DIR  = path.join(__dirname, 'docs');

// ── Load papers ────────────────────────────────────────────────
const allPapers = fs.existsSync(DB_FILE)
  ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
  : [];

allPapers.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

// ── Helpers ────────────────────────────────────────────────────
function esc(s) {
  return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

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
  return {
    'information':        'Information Econ',
    'corporate-political':'Corp. Political',
    'text-methods':       'Text Methods',
    'causal-inference':   'Causal Inf.',
    'corporate-finance':  'Corp. Finance',
    'supply-chain':       'Supply Chain',
  }[t] || t;
}

function getISOWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const dow = jan4.getUTCDay() || 7;
  const weekStart = new Date(jan4.getTime() - (dow - 1) * 86400000);
  const diff = d.getTime() - weekStart.getTime();
  const w = 1 + Math.floor(diff / (7 * 86400000));
  return `${d.getUTCFullYear()}-W${String(w).padStart(2,'0')}`;
}

function weekLabel(weekStr) {
  const [year, wPart] = weekStr.split('-W');
  const w = parseInt(wPart, 10);
  const jan4 = new Date(Date.UTC(parseInt(year), 0, 4));
  const dow = jan4.getUTCDay() || 7;
  const mon = new Date(jan4.getTime() - (dow - 1) * 86400000 + (w - 1) * 7 * 86400000);
  const sun = new Date(mon.getTime() + 6 * 86400000);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `Week ${w} · ${months[mon.getUTCMonth()]} ${mon.getUTCDate()}–${sun.getUTCDate()}, ${year}`;
}

// ── Paper card HTML ────────────────────────────────────────────
function paperCard(p) {
  const score   = p.relevance_score || 0;
  const sc      = scoreClass(score);
  const cc      = cardClass(score);
  const topics  = (p.topics || []).slice(0,3);
  const authors = (p.authors || []).slice(0,4).join(', ') + ((p.authors||[]).length > 4 ? ' et al.' : '');

  const topicTags = topics.map(t =>
    `<span class="topic-tag" data-topic="${t}">${topicLabel(t)}</span>`
  ).join('');

  let analysisHtml = '';
  if (p.analysis) {
    const a = p.analysis;
    const rows = [
      ['Research Question', a.research_question],
      ['Data',              a.data],
      ['Identification',    a.identification],
      ['Main Findings',     a.main_findings],
    ].filter(([,v]) => v).map(([label, val]) => `
      <div class="analysis-item">
        <label>${label}</label>
        <p>${esc(val)}</p>
      </div>`).join('');

    analysisHtml = `
    <div class="analysis-block">
      <div class="analysis-grid">${rows}</div>
      ${a.my_takeaway ? `<div class="takeaway-box"><strong>Takeaway:</strong> ${esc(a.my_takeaway)}</div>` : ''}
    </div>`;
  }

  const abstractText = p.abstract
    ? `<p class="paper-abstract">${esc(p.abstract.slice(0, 350))}${p.abstract.length > 350 ? '…' : ''}</p>`
    : '';

  return `<div class="paper-card${cc}" data-score="${score}" data-source="${p.source||'NBER'}" data-topics="${(p.topics||[]).join(',')}">
  <div class="paper-title"><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a></div>
  <div class="paper-meta">
    <span class="score-badge score-${sc}">${score.toFixed(1)}</span>
    <span class="source-tag">${p.source||'NBER'}</span>
    ${topicTags}
  </div>
  ${authors ? `<div class="paper-authors">${esc(authors)}</div>` : ''}
  ${abstractText}
  ${analysisHtml}
</div>`;
}

// ── Group by week ──────────────────────────────────────────────
const byWeek = new Map();
for (const p of allPapers) {
  const w = p.week || getISOWeek(p.date || '2026-01-01');
  if (!byWeek.has(w)) byWeek.set(w, []);
  byWeek.get(w).push(p);
}
const weeks = [...byWeek.keys()].sort((a,b) => b.localeCompare(a));

// ── Build stats ────────────────────────────────────────────────
const totalPapers  = allPapers.length;
const nberCount    = allPapers.filter(p => p.source === 'NBER').length;
const ssrnCount    = allPapers.filter(p => p.source === 'SSRN').length;
const fullReadCount= allPapers.filter(p => p.status === 'full_read').length;
const weeksCount   = weeks.length;
const updateDate   = new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'Asia/Shanghai'});

// ── Weekly sections ────────────────────────────────────────────
const weekSections = weeks.map(w => {
  const papers = byWeek.get(w).sort((a,b) => (b.relevance_score||0) - (a.relevance_score||0));
  const cards  = papers.map(paperCard).join('\n');
  const label  = weekLabel(w);
  const anchorId = w.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return `## ${label} {#${anchorId}}\n\n\`\`\`{=html}\n${cards}\n\`\`\`\n`;
}).join('\n');

// ── Write index.qmd ───────────────────────────────────────────
const qmd = `---
title: "Research Tracker"
subtitle: "Shujie Xu · Applied Micro & Corporate Finance"
date: "${updateDate}"
format:
  html:
    theme: [flatly, custom.scss]
    toc: true
    toc-location: left
    toc-title: "Weeks"
    toc-depth: 1
    page-layout: full
    smooth-scroll: true
    link-external-newwindow: true
    include-in-header:
      text: |
        <meta name="description" content="Weekly NBER + SSRN working paper digest, curated by research area.">
---

\`\`\`{=html}
<div class="tracker-stats">
  <span class="stat-item">📄 <strong>${totalPapers}</strong> papers tracked</span>
  <span class="stat-item">📅 <strong>${weeksCount}</strong> weeks covered</span>
  <span class="stat-item">🏛 <strong>${nberCount}</strong> NBER</span>
  ${ssrnCount > 0 ? `<span class="stat-item">📑 <strong>${ssrnCount}</strong> SSRN</span>` : ''}
  ${fullReadCount > 0 ? `<span class="stat-item">⭐ <strong>${fullReadCount}</strong> full reads</span>` : ''}
  <span class="stat-item" style="margin-left:auto; color:#adb5bd;">Updated ${updateDate}</span>
</div>

<div class="filter-bar" id="filterBar">
  <span class="filter-label">Filter:</span>
  <button class="filter-btn active" onclick="filterCards('all', this)">All</button>
  <button class="filter-btn" onclick="filterCards('top', this)">⭐ Top picks</button>
  <button class="filter-btn" onclick="filterCards('NBER', this)">NBER</button>
  <button class="filter-btn" onclick="filterCards('SSRN', this)">SSRN</button>
  <button class="filter-btn" onclick="filterCards('information', this)">Information</button>
  <button class="filter-btn" onclick="filterCards('corporate-political', this)">Corp. Political</button>
  <button class="filter-btn" onclick="filterCards('text-methods', this)">Text Methods</button>
  <button class="filter-btn" onclick="filterCards('supply-chain', this)">Supply Chain</button>
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
    } else if (filter === 'top') {
      show = parseFloat(card.dataset.score) >= 8.5;
    } else if (filter === 'NBER' || filter === 'SSRN') {
      show = card.dataset.source === filter;
    } else {
      show = (card.dataset.topics || '').split(',').includes(filter);
    }
    card.classList.toggle('hidden', !show);
  });
  // Show/hide week headers based on visible cards
  document.querySelectorAll('h2').forEach(h2 => {
    const section = h2.closest('section') || h2.parentElement;
    if (!section) return;
    const visible = section.querySelectorAll('.paper-card:not(.hidden)').length > 0;
    h2.style.display = visible ? '' : 'none';
  });
}
</script>
\`\`\`
`;

fs.writeFileSync(QMD_FILE, qmd);
console.log(`📝 Written index.qmd (${allPapers.length} papers, ${weeks.length} weeks)`);

// ── Quarto render ──────────────────────────────────────────────
try {
  execSync(`cd ${__dirname} && quarto render index.qmd --quiet`, { stdio: 'inherit' });

  // Quarto renders to project root (./index.html + ./index_files/); move to docs/
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // Move index.html
  const srcHtml  = path.join(__dirname, 'index.html');
  const destHtml = path.join(OUT_DIR, 'index.html');
  if (fs.existsSync(srcHtml)) fs.renameSync(srcHtml, destHtml);

  // Move index_files/ (Bootstrap CSS/JS)
  const srcFiles  = path.join(__dirname, 'index_files');
  const destFiles = path.join(OUT_DIR, 'index_files');
  if (fs.existsSync(srcFiles)) {
    if (fs.existsSync(destFiles))
      execSync(`rm -rf "${destFiles}"`);
    fs.renameSync(srcFiles, destFiles);
  }

  console.log(`✅ Rendered → docs/index.html`);
  console.log(`   ${totalPapers} papers · ${weeksCount} weeks · ${nberCount} NBER · ${ssrnCount} SSRN`);
} catch (e) {
  console.error('❌ quarto render failed:', e.message);
  process.exit(1);
}

// ── Git push ───────────────────────────────────────────────────
const shouldPush = process.argv.includes('--push');
if (shouldPush) {
  try {
    execSync(
      `cd ${__dirname} && git add docs/ index.qmd generate.js && git commit -m "📚 Paper tracker update ${new Date().toLocaleDateString('sv-SE', {timeZone:'Asia/Shanghai'})}" && git push`,
      { stdio: 'inherit' }
    );
    console.log('🚀 Pushed to GitHub Pages!');
  } catch (e) {
    console.error('⚠️ git push failed:', e.message);
  }
}
