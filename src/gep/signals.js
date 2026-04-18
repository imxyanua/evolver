// Opportunity signal names (shared with mutation.js and personality.js).
const OPPORTUNITY_SIGNALS = [
  'user_feature_request',
  'user_improvement_suggestion',
  'perf_bottleneck',
  'capability_gap',
  'stable_success_plateau',
  'external_opportunity',
  'recurring_error',
  'unsupported_input_type',
  'evolution_stagnation_detected',
  'repair_loop_detected',
  'force_innovation_after_repair_loop',
  'tool_bypass',
  'curriculum_target',
  'issue_already_resolved',
  'openclaw_self_healed',
  'empty_cycle_loop_detected',
  'explore_opportunity',
  'hub_search_miss_with_problem',
  'plateau_pivot_required',
  'plateau_pivot_suggested',
];

function hasOpportunitySignal(signals) {
  const list = Array.isArray(signals) ? signals : [];
  for (const name of OPPORTUNITY_SIGNALS) {
    if (list.includes(name)) return true;
    if (list.some(function (s) { return String(s).startsWith(name + ':'); })) return true;
  }
  return false;
}

// Build a de-duplication set from recent evolution events.
// Returns an object: { suppressedSignals: Set<string>, recentIntents: string[], consecutiveRepairCount: number }
function analyzeRecentHistory(recentEvents) {
  if (!Array.isArray(recentEvents) || recentEvents.length === 0) {
    return { suppressedSignals: new Set(), recentIntents: [], consecutiveRepairCount: 0 };
  }
  // Take only the last 10 events
  const recent = recentEvents.slice(-10);

  // Count consecutive same-intent runs at the tail
  let consecutiveRepairCount = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].intent === 'repair') {
      consecutiveRepairCount++;
    } else {
      break;
    }
  }

  // Count signal frequency in last 8 events: signal -> count
  const signalFreq = {};
  const geneFreq = {};
  const tail = recent.slice(-8);
  for (const evt of tail) {
    const sigs = Array.isArray(evt.signals) ? evt.signals : [];
    for (const s of sigs) {
      // Normalize: strip details suffix so frequency keys match dedup filter keys
      const key = s.startsWith('errsig:') ? 'errsig'
        : s.startsWith('recurring_errsig') ? 'recurring_errsig'
        : s.startsWith('user_feature_request:') ? 'user_feature_request'
        : s.startsWith('user_improvement_suggestion:') ? 'user_improvement_suggestion'
        : s;
      signalFreq[key] = (signalFreq[key] || 0) + 1;
    }
    const genes = Array.isArray(evt.genes_used) ? evt.genes_used : [];
    for (const gene of genes) {
      geneFreq[String(gene)] = (geneFreq[String(gene)] || 0) + 1;
    }
  }

  // Suppress signals that appeared in 3+ of the last 8 events (they are being over-processed)
  const suppressedSignals = new Set();
  for (const [sig, count] of Object.entries(signalFreq)) {
    if (count >= 3) suppressedSignals.add(sig);
  }

  const recentIntents = recent.map(function(e) { return e.intent || 'unknown'; });

  // Count empty cycles (blast_radius.files === 0) in last 8 events.
  // High ratio indicates the evolver is spinning without producing real changes.
  let emptyCycleCount = 0;
  for (const evt of tail) {
    const br = evt.blast_radius;
    const em = evt.meta && evt.meta.empty_cycle;
    if (em || (br && br.files === 0 && br.lines === 0)) {
      emptyCycleCount++;
    }
  }

  // Count consecutive empty cycles at the tail (not just total in last 8).
  // This detects saturation: the evolver has exhausted innovation space and keeps producing
  // zero-change cycles. Used to trigger graceful degradation to steady-state mode.
  let consecutiveEmptyCycles = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const br = recent[i].blast_radius;
    const em = recent[i].meta && recent[i].meta.empty_cycle;
    if (em || (br && br.files === 0 && br.lines === 0)) {
      consecutiveEmptyCycles++;
    } else {
      break;
    }
  }

  // Count consecutive failures at the tail of recent events.
  // This tells the evolver "you have been failing N times in a row -- slow down."
  let consecutiveFailureCount = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const outcome = recent[i].outcome;
    if (outcome && outcome.status === 'failed') {
      consecutiveFailureCount++;
    } else {
      break;
    }
  }

  // Count total failures in last 8 events (failure ratio).
  let recentFailureCount = 0;
  for (const evt of tail) {
    if (evt.outcome && evt.outcome.status === 'failed') recentFailureCount++;
  }

  return {
    suppressedSignals: suppressedSignals,
    recentIntents: recentIntents,
    consecutiveRepairCount: consecutiveRepairCount,
    emptyCycleCount: emptyCycleCount,
    consecutiveEmptyCycles: consecutiveEmptyCycles,
    consecutiveFailureCount: consecutiveFailureCount,
    recentFailureCount: recentFailureCount,
    recentFailureRatio: tail.length > 0 ? recentFailureCount / tail.length : 0,
    signalFreq: signalFreq,
    geneFreq: geneFreq,
  };
}

// ---------------------------------------------------------------------------
// Signal Extraction Strategy: Weighted Keyword Scoring (Layer 2)
// Unlike regex (binary hit/miss), keyword scoring accumulates weighted
// evidence from multiple keywords and fires only when confidence exceeds
// a threshold. This catches fuzzy/distributed patterns that no single
// regex can match.
// ---------------------------------------------------------------------------
const SIGNAL_PROFILES = {
  perf_bottleneck: {
    keywords: { 'slow': 3, 'timeout': 4, 'timed out': 4, 'latency': 3, 'bottleneck': 5,
                'lag': 2, 'delay': 2, 'hung': 3, 'freeze': 3, 'unresponsive': 4,
                'took too long': 4, 'high cpu': 4, 'high memory': 4, 'oom': 5,
                'out of memory': 5, 'performance': 2, 'throttle': 3 },
    threshold: 6,
  },
  capability_gap: {
    keywords: { 'not supported': 5, 'cannot': 1, 'unsupported': 4, 'not implemented': 5,
                'no way to': 3, 'missing feature': 5, 'not available': 3,
                'no support for': 4, 'unavailable': 3, 'incompatible': 3 },
    threshold: 5,
  },
  user_feature_request: {
    keywords: { 'add': 1, 'implement': 3, 'create': 2, 'build': 2, 'feature': 3,
                'i want': 3, 'i need': 3, 'we need': 3, 'please add': 4,
                'new function': 4, 'new module': 4, 'endpoint': 2, 'capability': 2,
                'support for': 2 },
    threshold: 6,
  },
  user_improvement_suggestion: {
    keywords: { 'improve': 3, 'enhance': 3, 'upgrade': 3, 'refactor': 4,
                'clean up': 3, 'simplify': 3, 'streamline': 3, 'optimize': 3,
                'could be better': 4, 'should be': 2, 'more efficient': 3 },
    threshold: 5,
  },
  recurring_error: {
    keywords: { 'error': 1, 'exception': 2, 'failed': 1, 'crash': 4,
                'again': 1, 'still': 1, 'keeps': 2, 'repeatedly': 4,
                'same error': 5, 'still failing': 5, 'not fixed': 4 },
    threshold: 7,
  },
  tool_bypass: {
    keywords: { 'exec': 2, 'shell': 2, 'subprocess': 3, 'child_process': 3,
                'curl': 2, 'wget': 2, 'ad-hoc': 3, 'workaround': 3,
                'hack': 2, 'manual': 1 },
    threshold: 6,
  },
  evolution_stagnation_detected: {
    keywords: { 'no change': 4, 'same result': 4, 'stuck': 3, 'plateau': 4,
                'stagnant': 5, 'no progress': 5, 'spinning': 3, 'idle': 2,
                'nothing new': 4, 'exhausted': 3 },
    threshold: 6,
  },
};

function _extractKeywordScore(lower) {
  const scored = [];
  for (const [signalName, profile] of Object.entries(SIGNAL_PROFILES)) {
    let totalScore = 0;
    for (const [kw, weight] of Object.entries(profile.keywords)) {
      let idx = 0;
      let count = 0;
      while (idx < lower.length && count < 20) {
        const pos = lower.indexOf(kw, idx);
        if (pos === -1) break;
        count++;
        idx = pos + kw.length;
      }
      totalScore += count * weight;
    }
    if (totalScore >= profile.threshold) {
      scored.push(signalName);
    }
  }
  return scored;
}

// ---------------------------------------------------------------------------
// Signal Extraction Strategy: LLM Semantic Analysis (Layer 3)
// Sends a corpus summary to the Hub for LLM-based signal extraction.
// Rate-limited to every N evolution cycles. Falls back silently on failure.
// ---------------------------------------------------------------------------
let _llmSignalCycleCount = 0;
const LLM_SIGNAL_INTERVAL = 5;

function _extractLLM(corpus) {
  _llmSignalCycleCount++;
  if (_llmSignalCycleCount % LLM_SIGNAL_INTERVAL !== 1) return [];

  try {
    const getHubUrl = require('./a2aProtocol').getHubUrl;
    const getHubNodeSecret = require('./a2aProtocol').getHubNodeSecret;
    const getNodeId = require('./a2aProtocol').getNodeId;
    const hubUrl = getHubUrl();
    const nodeSecret = getHubNodeSecret();
    if (!hubUrl || !nodeSecret) return [];

    const summary = corpus.slice(0, 2000);
    const postData = JSON.stringify({
      corpus_summary: summary,
      signal_types: OPPORTUNITY_SIGNALS,
      sender_id: getNodeId() || undefined,
    });

    const url = hubUrl + '/a2a/signal/analyze';

    // Use execSync + curl for truly synchronous HTTP. Node's http.request() is
    // async and its callbacks cannot fire inside a synchronous spin-wait loop
    // because execSync blocks the event loop.
    const curlCmd = 'curl -s -m 10 -X POST'
      + ' -H "Content-Type: application/json"'
      + ' -H "Authorization: Bearer ' + nodeSecret + '"'
      + ' -d ' + JSON.stringify(postData).replace(/'/g, "'\\''")
      + ' ' + JSON.stringify(url);

    const execSync = require('child_process').execSync;
    let stdout = '';
    try {
      stdout = execSync(curlCmd, {
        timeout: 12000,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf8',
      });
    } catch (_) {
      return [];
    }

    if (!stdout || typeof stdout !== 'string') return [];

    const parsed = JSON.parse(stdout);
    if (Array.isArray(parsed.signals)) {
      return parsed.signals.filter(function (s) {
        return typeof s === 'string' && s.length > 0 && s.length < 200;
      }).slice(0, 10);
    }
    return [];
  } catch (e) {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Signal Merge: combine results from all extraction strategies.
// Deduplicates and logs per-layer contribution for observability.
// ---------------------------------------------------------------------------
function _mergeSignals(regexSignals, scoreSignals, llmSignals) {
  const merged = new Set();
  for (const s of regexSignals) merged.add(s);
  for (const s of scoreSignals) merged.add(s);
  for (const s of llmSignals) merged.add(s);

  const scoreOnly = scoreSignals.filter(function (s) { return !regexSignals.includes(s); });
  const llmOnly = llmSignals.filter(function (s) { return !regexSignals.includes(s) && !scoreSignals.includes(s); });
  const overlap = regexSignals.filter(function (s) { return scoreSignals.includes(s) || llmSignals.includes(s); });

  if (scoreOnly.length > 0 || llmOnly.length > 0 || overlap.length > 0) {
    console.log('[Signals] Multi-strategy: regex=' + regexSignals.length +
      ', score=' + scoreSignals.length +
      ', llm=' + llmSignals.length +
      ', merged=' + merged.size +
      (scoreOnly.length > 0 ? ' | score-only: ' + scoreOnly.join(', ') : '') +
      (llmOnly.length > 0 ? ' | llm-only: ' + llmOnly.join(', ') : '') +
      (overlap.length > 0 ? ' | confirmed: ' + overlap.join(', ') : ''));
  }

  return Array.from(merged);
}

// ---------------------------------------------------------------------------
// Signal Extraction Strategy: Regex Pattern Matching (Layer 1)
// Deterministic, zero-latency, hand-crafted rules for known signal patterns.
// ---------------------------------------------------------------------------
function _extractRegex(corpus, lower, errorHit) {
  const signals = [];

  if (errorHit) signals.push('log_error');

  try {
    const lines = corpus
      .split('\n')
      .map(function (l) { return String(l || '').trim(); })
      .filter(Boolean);

    const errLine =
      lines.find(function (l) { return /\b(typeerror|referenceerror|syntaxerror)\b\s*:|error\s*:|exception\s*:|\[error|错误\s*[：:]|异常\s*[：:]|报错\s*[：:]|失败\s*[：:]/i.test(l); }) ||
      null;

    if (errLine) {
      const clipped = errLine.replace(/\s+/g, ' ').slice(0, 260);
      signals.push('errsig:' + clipped);
    }
  } catch (e) { /* error-line extraction non-critical */ }

  if (lower.includes('memory.md missing')) signals.push('memory_missing');
  if (lower.includes('user.md missing')) signals.push('user_missing');
  if (lower.includes('key missing')) signals.push('integration_key_missing');
  if (lower.includes('no session logs found') || lower.includes('no jsonl files')) signals.push('session_logs_missing');
  if (process.platform === 'win32' && (lower.includes('pgrep') || lower.includes('ps aux') || lower.includes('cat >') || lower.includes('heredoc'))) {
    signals.push('windows_shell_incompatible');
  }
  if (lower.includes('path.resolve(__dirname, \'../../../')) signals.push('path_outside_workspace');

  // Protocol-specific drift signals
  if (lower.includes('prompt') && !lower.includes('evolutionevent')) signals.push('protocol_drift');

  // --- Recurring error detection (robustness signals) ---
  // Count repeated identical errors -- these indicate systemic issues that need automated fixes
  try {
    const errorCounts = {};
    const errPatterns = corpus.match(/(?:LLM error|"error"|"status":\s*"error")[^}]{0,200}/gi) || [];
    for (const ep of errPatterns) {
      // Normalize to a short key
      const key = ep.replace(/\s+/g, ' ').slice(0, 100);
      errorCounts[key] = (errorCounts[key] || 0) + 1;
    }
    const recurringErrors = Object.entries(errorCounts).filter(function (e) { return e[1] >= 3; });
    if (recurringErrors.length > 0) {
      signals.push('recurring_error');
      // Include the top recurring error signature for the agent to diagnose
      const topErr = recurringErrors.sort(function (a, b) { return b[1] - a[1]; })[0];
      signals.push('recurring_errsig(' + topErr[1] + 'x):' + topErr[0].slice(0, 150));
    }
  } catch (e) { /* recurring error detection non-critical */ }

  // --- Unsupported input type (e.g. GIF, video formats the LLM can't handle) ---
  if (/unsupported mime|unsupported.*type|invalid.*mime/i.test(lower)) {
    signals.push('unsupported_input_type');
  }

  // --- Opportunity signals (innovation / feature requests) ---
  // Support 4 languages: EN, ZH-CN, ZH-TW, JA. Attach snippet for selector/prompt use.

  let featureRequestSnippet = '';
  const featEn = corpus.match(/\b(add|implement|create|build|make|develop|write|design)\b[^.?!\n]{3,120}\b(feature|function|module|capability|tool|support|endpoint|command|option|mode)\b/i);
  if (featEn) featureRequestSnippet = featEn[0].replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!featureRequestSnippet && /\b(i want|i need|we need|please add|can you add|could you add|let'?s add)\b/i.test(lower)) {
    const featWant = corpus.match(/.{0,80}\b(i want|i need|we need|please add|can you add|could you add|let'?s add)\b.{0,80}/i);
    featureRequestSnippet = featWant ? featWant[0].replace(/\s+/g, ' ').trim().slice(0, 200) : 'feature request';
  }
  if (!featureRequestSnippet && /加个|实现一下|做个|想要\s*一个|需要\s*一个|帮我加|帮我开发|加一下|新增一个|加个功能|做个功能|我想/.test(corpus)) {
    const featZh = corpus.match(/.{0,100}(加个|实现一下|做个|想要\s*一个|需要\s*一个|帮我加|帮我开发|加一下|新增一个|加个功能|做个功能).{0,100}/);
    if (featZh) featureRequestSnippet = featZh[0].replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!featureRequestSnippet && /我想/.test(corpus)) {
      const featWantZh = corpus.match(/我想\s*[，,\.。、\s]*([\s\S]{0,400})/);
      featureRequestSnippet = featWantZh ? (featWantZh[1].replace(/\s+/g, ' ').trim().slice(0, 200) || '功能需求') : '功能需求';
    }
    if (!featureRequestSnippet) featureRequestSnippet = '功能需求';
  }
  if (!featureRequestSnippet && /加個|實現一下|做個|想要一個|請加|新增一個|加個功能|做個功能|幫我加/.test(corpus)) {
    const featTw = corpus.match(/.{0,100}(加個|實現一下|做個|想要一個|請加|新增一個|加個功能|做個功能|幫我加).{0,100}/);
    featureRequestSnippet = featTw ? featTw[0].replace(/\s+/g, ' ').trim().slice(0, 200) : '功能需求';
  }
  if (!featureRequestSnippet && /追加|実装|作って|機能を|追加して|が欲しい|を追加|してほしい/.test(corpus)) {
    const featJa = corpus.match(/.{0,100}(追加|実装|作って|機能を|追加して|が欲しい|を追加|してほしい).{0,100}/);
    featureRequestSnippet = featJa ? featJa[0].replace(/\s+/g, ' ').trim().slice(0, 200) : '機能要望';
  }
  if (featureRequestSnippet || /\b(add|implement|create|build|make|develop|write|design)\b[^.?!\n]{3,60}\b(feature|function|module|capability|tool|support|endpoint|command|option|mode)\b/i.test(corpus) ||
      /\b(i want|i need|we need|please add|can you add|could you add|let'?s add)\b/i.test(lower) ||
      /加个|实现一下|做个|想要\s*一个|需要\s*一个|帮我加|帮我开发|加一下|新增一个|加个功能|做个功能|我想/.test(corpus) ||
      /加個|實現一下|做個|想要一個|請加|新增一個|加個功能|做個功能|幫我加/.test(corpus) ||
      /追加|実装|作って|機能を|追加して|が欲しい|を追加|してほしい/.test(corpus)) {
    signals.push('user_feature_request');
    if (featureRequestSnippet) signals.push('user_feature_request:' + featureRequestSnippet);
  }

  // user_improvement_suggestion: 4 languages + snippet
  let improvementSnippet = '';
  if (!errorHit) {
    const impEn = corpus.match(/.{0,80}\b(should be|could be better|improve|enhance|upgrade|refactor|clean up|simplify|streamline)\b.{0,80}/i);
    if (impEn) improvementSnippet = impEn[0].replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!improvementSnippet && /改进一下|优化一下|简化|重构|整理一下|弄得更好/.test(corpus)) {
      const impZh = corpus.match(/.{0,100}(改进一下|优化一下|简化|重构|整理一下|弄得更好).{0,100}/);
      improvementSnippet = impZh ? impZh[0].replace(/\s+/g, ' ').trim().slice(0, 200) : '改进建议';
    }
    if (!improvementSnippet && /改進一下|優化一下|簡化|重構|整理一下|弄得更好/.test(corpus)) {
      const impTw = corpus.match(/.{0,100}(改進一下|優化一下|簡化|重構|整理一下|弄得更好).{0,100}/);
      improvementSnippet = impTw ? impTw[0].replace(/\s+/g, ' ').trim().slice(0, 200) : '改進建議';
    }
    if (!improvementSnippet && /改善|最適化|簡素化|リファクタ|良くして|改良/.test(corpus)) {
      const impJa = corpus.match(/.{0,100}(改善|最適化|簡素化|リファクタ|良くして|改良).{0,100}/);
      improvementSnippet = impJa ? impJa[0].replace(/\s+/g, ' ').trim().slice(0, 200) : '改善要望';
    }
    const hasImprovement = improvementSnippet ||
      /\b(should be|could be better|improve|enhance|upgrade|refactor|clean up|simplify|streamline)\b/i.test(lower) ||
      /改进一下|优化一下|简化|重构|整理一下|弄得更好/.test(corpus) ||
      /改進一下|優化一下|簡化|重構|整理一下|弄得更好/.test(corpus) ||
      /改善|最適化|簡素化|リファクタ|良くして|改良/.test(corpus);
    if (hasImprovement) {
      signals.push('user_improvement_suggestion');
      if (improvementSnippet) signals.push('user_improvement_suggestion:' + improvementSnippet);
    }
  }

  // perf_bottleneck: performance issues detected
  if (/\b(slow|timeout|timed?\s*out|latency|bottleneck|took too long|performance issue|high cpu|high memory|oom|out of memory)\b/i.test(lower)) {
    signals.push('perf_bottleneck');
  }

  // capability_gap: something is explicitly unsupported or missing
  if (/\b(not supported|cannot|doesn'?t support|no way to|missing feature|unsupported|not available|not implemented|no support for)\b/i.test(lower)) {
    // Only fire if it is not just a missing file/config signal
    if (!signals.includes('memory_missing') && !signals.includes('user_missing') && !signals.includes('session_logs_missing')) {
      signals.push('capability_gap');
    }
  }

  // --- Tool Usage Analytics ---
  const toolUsage = {};
  const toolMatches = corpus.match(/\[TOOL:\s*([\w-]+)\]/g) || [];

  // Extract exec commands to identify benign loops (like watchdog checks)
  const execCommands = corpus.match(/exec: (node\s+[\w\/\.-]+\.js\s+ensure)/g) || [];
  const benignExecCount = execCommands.length;

  for (const match of toolMatches) {
    const toolName = match.match(/\[TOOL:\s*([\w-]+)\]/)[1];
    toolUsage[toolName] = (toolUsage[toolName] || 0) + 1;
  }

  // Adjust exec count by subtracting benign commands
  if (toolUsage['exec']) {
    toolUsage['exec'] = Math.max(0, toolUsage['exec'] - benignExecCount);
  }

  Object.keys(toolUsage).forEach(function(tool) {
    if (toolUsage[tool] >= 10) { // Bumped threshold from 5 to 10
      signals.push('high_tool_usage:' + tool);
    }
    // Detect repeated exec usage (often a sign of manual loops or inefficient automation)
    if (tool === 'exec' && toolUsage[tool] >= 5) { // Bumped threshold from 3 to 5
      signals.push('repeated_tool_usage:exec');
    }
  });

  // --- Tool bypass detection ---
  // When the agent uses shell/exec to run ad-hoc scripts instead of registered tools,
  // it indicates a tool integrity issue (bypassing the tool layer).
  const bypassPatterns = [
    /node\s+\S+\.m?js/,
    /npx\s+/,
    /curl\s+.*api/i,
    /python\s+\S+\.py/,
  ];
  const execContent = corpus.match(/exec:.*$/gm) || [];
  let toolBypassFound = false;
  for (const line of execContent) {
    for (const pattern of bypassPatterns) {
      if (pattern.test(line)) {
        signals.push('tool_bypass');
        toolBypassFound = true;
        break;
      }
    }
    if (toolBypassFound) break;
  }

  return signals;
}

// ---------------------------------------------------------------------------
// extractSignals: Multi-strategy orchestrator.
// Calls three extraction layers (regex, keyword scoring, LLM semantic),
// merges their outputs, then applies post-processing (prioritization,
// history-based dedup, innovation forcing).
// Signature and return type are unchanged -- callers are not affected.
// ---------------------------------------------------------------------------
function extractSignals({ recentSessionTranscript, todayLog, memorySnippet, userSnippet, recentEvents }) {
  const corpus = [
    String(recentSessionTranscript || ''),
    String(todayLog || ''),
    String(memorySnippet || ''),
    String(userSnippet || ''),
  ].join('\n');
  const lower = corpus.toLowerCase();

  const history = analyzeRecentHistory(recentEvents || []);

  const errorHit = /\[error\]|error:|exception:|iserror":true|"status":\s*"error"|"status":\s*"failed"|错误\s*[：:]|异常\s*[：:]|报错\s*[：:]|失败\s*[：:]/.test(lower);

  // Layer 1: Regex (deterministic, 0ms)
  const regexSignals = _extractRegex(corpus, lower, errorHit);

  // Layer 2: Weighted keyword scoring (statistical, 0ms)
  const scoreSignals = _extractKeywordScore(lower);

  // Layer 3: LLM semantic analysis (rate-limited, async, optional)
  const llmSignals = _extractLLM(corpus);

  // Merge all layers
  let signals = _mergeSignals(regexSignals, scoreSignals, llmSignals);

  // --- Post-processing (applies to merged signal set) ---

  // Signal prioritization: remove cosmetic signals when actionable ones exist
  const actionable = signals.filter(function (s) {
    return s !== 'user_missing' && s !== 'memory_missing' && s !== 'session_logs_missing' && s !== 'windows_shell_incompatible';
  });
  if (actionable.length > 0) {
    signals = actionable;
  }

  // De-duplication: suppress signals that have been over-processed in recent history
  if (history.suppressedSignals.size > 0) {
    const beforeDedup = signals.length;
    signals = signals.filter(function (s) {
      const key = s.startsWith('errsig:') ? 'errsig'
        : s.startsWith('recurring_errsig') ? 'recurring_errsig'
        : s.startsWith('user_feature_request:') ? 'user_feature_request'
        : s.startsWith('user_improvement_suggestion:') ? 'user_improvement_suggestion'
        : s;
      return !history.suppressedSignals.has(key);
    });
    if (beforeDedup > 0 && signals.length === 0) {
      signals.push('evolution_stagnation_detected');
      signals.push('stable_success_plateau');
    }
  }

  // Force innovation after 3+ consecutive repairs
  if (history.consecutiveRepairCount >= 3) {
    signals = signals.filter(function (s) {
      return s !== 'log_error' && !s.startsWith('errsig:') && !s.startsWith('recurring_errsig');
    });
    if (signals.length === 0) {
      signals.push('repair_loop_detected');
      signals.push('stable_success_plateau');
    }
    signals.push('force_innovation_after_repair_loop');
  }

  // Force innovation after too many empty cycles (zero blast radius)
  if (history.emptyCycleCount >= 4) {
    signals = signals.filter(function (s) {
      return s !== 'log_error' && !s.startsWith('errsig:') && !s.startsWith('recurring_errsig');
    });
    if (!signals.includes('empty_cycle_loop_detected')) signals.push('empty_cycle_loop_detected');
    if (!signals.includes('stable_success_plateau')) signals.push('stable_success_plateau');
  }

  // Saturation detection (graceful degradation)
  if (history.consecutiveEmptyCycles >= 5) {
    if (!signals.includes('force_steady_state')) signals.push('force_steady_state');
    if (!signals.includes('evolution_saturation')) signals.push('evolution_saturation');
  } else if (history.consecutiveEmptyCycles >= 3) {
    if (!signals.includes('evolution_saturation')) signals.push('evolution_saturation');
  }

  // Exploration opportunity: when saturated, inject explore signal so the
  // idle gating path can trigger proactive exploration instead of sleeping.
  if (history.consecutiveEmptyCycles >= 3 && !signals.includes('explore_opportunity')) {
    signals.push('explore_opportunity');
  }

  // Failure streak awareness
  if (history.consecutiveFailureCount >= 3) {
    signals.push('consecutive_failure_streak_' + history.consecutiveFailureCount);
    if (history.consecutiveFailureCount >= 5) {
      signals.push('failure_loop_detected');
      let topGene = null;
      let topGeneCount = 0;
      for (const [gene, count] of Object.entries(history.geneFreq)) {
        if (count > topGeneCount) {
          topGeneCount = count;
          topGene = gene;
        }
      }
      if (topGene) {
        signals.push('ban_gene:' + topGene);
      }
    }
  }

  // High failure ratio in recent history (>= 75% failed in last 8 cycles)
  if (history.recentFailureRatio >= 0.75) {
    signals.push('high_failure_ratio');
    signals.push('force_innovation_after_repair_loop');
  }

  // Plateau detection: recent scores trending down or stagnant.
  // Uses score data from recentEvents to detect diminishing returns.
  if (Array.isArray(recentEvents) && recentEvents.length >= 4) {
    const recentScores = recentEvents.slice(-6).map(function (e) {
      return e.outcome && typeof e.outcome.score === 'number' ? e.outcome.score : -1;
    }).filter(function (s) { return s >= 0; });
    if (recentScores.length >= 3) {
      const avgScore = recentScores.reduce(function (a, b) { return a + b; }, 0) / recentScores.length;
      const improving = recentScores.length >= 2 && recentScores[recentScores.length - 1] > recentScores[recentScores.length - 2] + 0.05;
      if (avgScore < 0.35 && !improving) {
        signals.push('plateau_pivot_required');
      } else if (avgScore < 0.55 && !improving && history.consecutiveRepairCount >= 2) {
        signals.push('plateau_pivot_suggested');
      }
    }
  }

  // If no signals at all, add a default innovation signal
  if (signals.length === 0) {
    signals.push('stable_success_plateau');
  }

  return Array.from(new Set(signals));
}

module.exports = {
  extractSignals, hasOpportunitySignal, analyzeRecentHistory,
  OPPORTUNITY_SIGNALS, SIGNAL_PROFILES,
  _extractRegex, _extractKeywordScore, _extractLLM, _mergeSignals,
};
