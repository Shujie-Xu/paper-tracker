#!/usr/bin/env node
/**
 * paper-tracker · generate.js
 * Renders papers-db.json → docs/index.html (GitHub Pages)
 * Usage: node generate.js [--push]
 */

'use strict';
const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TEMPLATE  = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');
const DB_FILE   = path.join(__dirname, 'papers-db.json');
const OUT_DIR   = path.join(__dirname, 'docs');
const OUT_FILE  = path.join(OUT_DIR, 'index.html');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Load DB ────────────────────────────────────────────────────
const allPapers = fs.existsSync(DB_FILE)
  ? JSON.parse(fs.readFileSync(DB_FILE, 'utf8'))
  : [];

// Sort newest first
allPapers.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

// ── Group by week ──────────────────────────────────────────────
function getISOWeek(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7;
  const weekStart = new Date(jan4.getTime() - (dayOfWeek - 1) * 86400000);
  const diff = d.getTime() - weekStart.getTime();
  const weekNum = 1 + Math.floor(diff / (7 * 86400000));
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function weekLabel(weekStr) {
  // e.g. "2026-W08" → "Week 8 · Feb 2026"
  const [year, wPart] = weekStr.split('-W');
  const weekNum = parseInt(wPart, 10);
  // Compute Monday of that ISO week
  const jan4 = new Date(Date.UTC(parseInt(year), 0, 4));
  const dayOfWeek = jan4.getUTCDay() || 7;
  const weekStart = new Date(jan4.getTime() - (dayOfWeek - 1) * 86400000 + (weekNum - 1) * 7 * 86400000);
  const weekEnd = new Date(weekStart.getTime() + 6 * 86400000);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `Week ${weekNum} · ${months[weekStart.getUTCMonth()]} ${weekStart.getUTCDate()}–${weekEnd.getUTCDate()}, ${year}`;
}

const byWeek = new Map();
allPapers.forEach(p => {
  const wk = p.week || getISOWeek(p.date || new Date().toISOString().slice(0,10));
  if (!byWeek.has(wk)) byWeek.set(wk, []);
  byWeek.get(wk).push(p);
});

// ── Helpers ────────────────────────────────────────────────────
const TOPIC_BADGE_MAP = {
  'information':       'badge-info',
  'corporate-political': 'badge-pol',
  'housing':           'badge-urban',
  'text-methods':      'badge-method',
  'causal-inference':  'badge-method',
  'corporate-finance': 'badge-cf',
};

const TOPIC_LABEL = {
  'information':         'Information Econ.',
  'corporate-political': 'Corp. Political',
  'housing':             'Housing / RE',
  'text-methods':        'Text Methods',
  'causal-inference':    'Causal Inference',
  'corporate-finance':   'Corporate Finance',
};

function sourceBadge(source) {
  const cls = source === 'NBER' ? 'badge-nber' : source === 'SSRN' ? 'badge-ssrn' : 'badge-other';
  return `<span class="badge ${cls}">${source}</span>`;
}

function topicBadges(topics) {
  return (topics || []).map(t =>
    `<span class="badge ${TOPIC_BADGE_MAP[t] || 'badge-other'}">${TOPIC_LABEL[t] || t}</span>`
  ).join('');
}

function jelTags(codes) {
  return (codes || []).map(c => `<span class="jel-tag">${c}</span>`).join('');
}

function topicDataTags(topics) {
  return (topics || []).join(' ');
}

function relevanceDots(score) {
  const tier = score >= 9 ? 'top' : score >= 7 ? 'high' : 'mid';
  const filled = Math.round(score / 2);
  return Array.from({ length: 5 }, (_, i) =>
    `<div class="relevance-dot${i < filled ? ` filled-${tier}` : ''}"></div>`
  ).join('');
}

function relClass(score) {
  if (score >= 9) return 'top';
  if (score >= 7) return 'high';
  return 'mid';
}

function cardClass(score) {
  if (score >= 9) return ' top-pick';
  if (score >= 7) return ' high-relevance';
  return '';
}

function escHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function abstractHtml(abstract, maxLen = 240) {
  if (!abstract) return '';
  const short = abstract.length <= maxLen
    ? abstract
    : abstract.slice(0, maxLen).replace(/\w+$/, '') + '…';
  const hasMore = abstract.length > maxLen;
  return `<div class="paper-abstract">
    <span class="abstract-short">${escHtml(short)}</span>${hasMore
      ? `<span class="abstract-full" style="display:none"> ${escHtml(abstract.slice(short.length - 1))}</span>
         <button class="abstract-toggle" onclick="toggleAbstract(this)">Show more</button>`
      : ''}
  </div>`;
}

function analysisHtml(a, score) {
  if (!a) return '';
  const breakdown = a.relevance_breakdown || {};
  const dims = [
    { label: 'Information economics', key: 'information_economics' },
    { label: 'Corporate political',   key: 'corporate_political' },
    { label: 'Housing markets',       key: 'housing_markets' },
    { label: 'Text-based methods',    key: 'text_methods' },
    { label: 'Causal inference',      key: 'causal_inference' },
  ];
  const barsHtml = Object.keys(breakdown).length
    ? `<div class="rel-breakdown">
        ${dims.map(d => {
          const v = breakdown[d.key] || 0;
          return `<div class="rel-row">
            <div class="rel-label">${d.label}</div>
            <div class="rel-bar-bg"><div class="rel-bar-fill" style="width:${v * 20}%"></div></div>
            <div class="rel-score">${v}</div>
          </div>`;
        }).join('')}
      </div>`
    : '';

  const blocks = [
    { label: '📌 Research Question', key: 'research_question' },
    { label: '📦 Data', key: 'data' },
    { label: '🔬 Identification Strategy', key: 'identification' },
    { label: '📊 Main Findings', key: 'main_findings' },
    { label: '⚠️ Limitations', key: 'limitations' },
  ];
  const fullWidthBlocks = [
    { label: '🔗 Connection to My Work', key: 'connection_to_my_work', highlight: true },
    { label: '💡 My Takeaway', key: 'my_takeaway' },
  ];

  const renderBlock = (b, full) => {
    const text = a[b.key];
    if (!text) return '';
    const paras = text.trim().split(/\n\n+/).map(p =>
      `<p>${escHtml(p).replace(/\n/g, '<br>')}</p>`).join('');
    return `<div class="analysis-block${full ? ' full-width' : ''}${b.highlight ? ' highlight' : ''}">
      <div class="analysis-label">${b.label}</div>
      <div class="analysis-text">${paras}</div>
    </div>`;
  };

  return `<div class="analysis-panel" id="">
    ${a.relevance_reason ? `<p style="font-size:13px;color:var(--muted);margin-bottom:14px;font-style:italic;">${escHtml(a.relevance_reason)}</p>` : ''}
    ${barsHtml}
    <div class="analysis-grid">
      ${blocks.map(b => renderBlock(b, false)).join('')}
      ${fullWidthBlocks.map(b => renderBlock(b, true)).join('')}
    </div>
  </div>`;
}

function renderCard(p) {
  const score = p.relevance_score || 0;
  const topics = p.topics || [];
  const analysis = p.analysis || null;

  return `<div class="paper-card${cardClass(score)}"
      data-source="${escHtml(p.source)}"
      data-topics="${topicDataTags(topics)}"
      data-score="${score}">

    <div class="card-header">
      <div class="card-badges">
        ${sourceBadge(p.source)}
        ${topicBadges(topics)}
      </div>
      <div class="relevance-indicator">
        <span class="relevance-score ${relClass(score)}">${score.toFixed(1)}</span>
        <div class="relevance-dots">${relevanceDots(score)}</div>
      </div>
    </div>

    <div class="paper-title">
      <a href="${escHtml(p.url || '#')}" target="_blank" rel="noopener">${escHtml(p.title)}</a>
    </div>

    <div class="paper-authors">
      ${(p.authors || []).map(a => `<span class="author">${escHtml(a)}</span>`).join(', ')}
    </div>

    <div class="paper-meta">
      <span>${escHtml(p.date || '')}</span>
      ${p.nber_program ? `<span class="paper-meta-sep">·</span><span>NBER ${p.nber_program.join(', ')}</span>` : ''}
      ${(p.jel_codes || []).length ? `<span class="paper-meta-sep">·</span>` : ''}
      <div class="jel-tags">${jelTags(p.jel_codes)}</div>
    </div>

    ${abstractHtml(p.abstract)}

    <div class="card-footer">
      <div class="topic-tags">
        ${topics.map(t => `<span class="topic-tag">#${TOPIC_LABEL[t] || t}</span>`).join('')}
      </div>
      <div class="card-actions">
        ${p.pdf_url ? `<a class="btn btn-outline" href="${escHtml(p.pdf_url)}" target="_blank" rel="noopener">PDF</a>` : ''}
        ${analysis ? `<button class="btn btn-primary" onclick="toggleAnalysis(this)">View Analysis</button>` : ''}
      </div>
    </div>

    ${analysis ? analysisHtml(analysis, score) : ''}
  </div>`;
}

// ── Render sections ────────────────────────────────────────────
let sectionsHtml = '';
const weeksArr = [...byWeek.entries()].sort((a, b) => b[0].localeCompare(a[0]));

if (weeksArr.length === 0) {
  sectionsHtml = `<div class="empty-state">
    <h3>No papers yet</h3>
    <p>The tracker will populate after the first scheduled run.</p>
  </div>`;
} else {
  weeksArr.forEach(([weekKey, papers]) => {
    const topPicks = papers.filter(p => (p.relevance_score || 0) >= 9).length;
    sectionsHtml += `<div class="week-section" data-week="${weekKey}">
      <div class="week-header">
        <span class="week-label">${weekLabel(weekKey)}</span>
        <span class="week-count">${papers.length} papers</span>
        ${topPicks > 0 ? `<span class="week-highlight">★ ${topPicks} top pick${topPicks > 1 ? 's' : ''}</span>` : ''}
      </div>
      ${papers.map(renderCard).join('\n')}
    </div>`;
  });
}

// ── Stats ──────────────────────────────────────────────────────
const nberCount = allPapers.filter(p => p.source === 'NBER').length;
const ssrnCount = allPapers.filter(p => p.source === 'SSRN').length;
const latestWeek = weeksArr[0] ? weeksArr[0][1] : [];
const weekFetched  = latestWeek.length;
const weekDeepRead = latestWeek.filter(p => p.status === 'full_read').length;
const weekTopPicks = latestWeek.filter(p => (p.relevance_score || 0) >= 9).length;
const uniqueWeeks  = weeksArr.length;

const updateDate = new Date().toLocaleDateString('en-US', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric', month: 'short', day: 'numeric'
});

// ── Inject into template ───────────────────────────────────────
let html = TEMPLATE
  .replace(/\{\{SITE_TITLE\}\}/g,    'Shujie Xu')
  .replace(/\{\{TOTAL_PAPERS\}\}/g,  allPapers.length)
  .replace(/\{\{WEEKS_COVERED\}\}/g, uniqueWeeks)
  .replace(/\{\{COUNT_NBER\}\}/g,    nberCount)
  .replace(/\{\{COUNT_SSRN\}\}/g,    ssrnCount)
  .replace(/\{\{WEEK_FETCHED\}\}/g,  weekFetched)
  .replace(/\{\{WEEK_DEEPREAD\}\}/g, weekDeepRead)
  .replace(/\{\{WEEK_TOPPICKS\}\}/g, weekTopPicks)
  .replace(/\{\{UPDATE_DATE\}\}/g,   updateDate)
  .replace(/\{\{SECTIONS\}\}/g,      sectionsHtml)
  .replace(/\{\{PAPERS_JSON\}\}/g,   JSON.stringify(allPapers));

fs.writeFileSync(OUT_FILE, html, 'utf8');
console.log(`✅ Generated: ${OUT_FILE}`);
console.log(`   ${allPapers.length} papers · ${uniqueWeeks} weeks · ${nberCount} NBER · ${ssrnCount} SSRN`);

// ── Optional push ──────────────────────────────────────────────
if (process.argv.includes('--push')) {
  try {
    execSync(`cd "${__dirname}" && git add docs/ papers-db.json && git commit -m "📚 Paper tracker update ${updateDate}" && git push`, { stdio: 'inherit' });
    console.log('🚀 Pushed to GitHub Pages!');
  } catch (e) {
    console.error('⚠️ git push failed:', e.message);
  }
}
