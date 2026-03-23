// app.js — Mission Control Dark dashboard

// ── State ────────────────────────────────────────────────────────────────────

var currentWorkerStatus = 'idle';
var currentJob = null;          // ActiveJob | null
var historyRows = [];           // JobHistoryRow[]
var pendingCount = 0;
var retryVal = 0;
var lastConfig = null;          // last loaded config object

// Stats counters (derived from snapshot + incremental events)
var statsProcessed = 0;
var statsDoneCount = 0;

// ── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  try {
    const snapshot = await fetch('/api/state').then(function(r) { return r.json(); });
    populateFromSnapshot(snapshot);

    const config = await fetch('/api/config').then(function(r) { return r.json(); });
    populateSettingsForm(config);
  } catch (err) {
    console.error('Failed to initialize dashboard:', err);
    var errEl = document.getElementById('config-error');
    if (errEl) {
      errEl.textContent = 'Could not connect to agent-worker. Is the process running?';
      errEl.style.display = 'block';
    }
  }
}

init();

// ── SSE ──────────────────────────────────────────────────────────────────────

var _reconnectTimer = null;

function connectSSE() {
  if (_reconnectTimer) {
    clearTimeout(_reconnectTimer);
    _reconnectTimer = null;
  }
  var es = new EventSource('/api/events');
  es.onmessage = function(e) {
    handleEvent(JSON.parse(e.data));
  };
  es.onerror = function() {
    es.close();
    fetch('/api/state').then(function(r) { return r.json(); }).then(populateFromSnapshot).catch(function() {});
    if (!_reconnectTimer) {
      _reconnectTimer = setTimeout(function() {
        _reconnectTimer = null;
        connectSSE();
      }, 2000);
    }
  };
}

connectSSE();

// ── Event handler ─────────────────────────────────────────────────────────────

function handleEvent(event) {
  switch (event.type) {
    case 'worker_status':   updateWorkerStatus(event.status); break;
    case 'job_start':       showActiveJob(event.job); break;
    case 'job_log':         appendLogLine(event.line); break;
    case 'job_stage':       updateJobStage(event.stage); break;
    case 'job_end':         handleJobEnd(event); break;
    case 'job_error':       handleJobError(event.error); break;
    case 'job_dismiss':     clearActiveJob(); break;
    case 'history_add':     addHistoryRow(event.row); break;
    case 'pending_tickets': updatePendingCount(event.count); break;
    case 'config_update':   fetch('/api/config').then(function(r) { return r.json(); }).then(populateSettingsForm); break;
  }
}

// ── Snapshot population ───────────────────────────────────────────────────────

function populateFromSnapshot(snapshot) {
  updateWorkerStatus(snapshot.workerStatus);

  historyRows = snapshot.history || [];
  statsProcessed = snapshot.ticketsProcessed || 0;
  statsDoneCount = historyRows.filter(function(r) { return r.status === 'done' || r.status === 'review'; }).length;

  renderHistoryFull();
  renderHistoryMini();
  updateStats();

  if (snapshot.activeJob) {
    showActiveJob(snapshot.activeJob);
    var logPane = document.getElementById('log-pane');
    if (logPane && snapshot.activeJob.logLines) {
      clearLogPane(logPane);
      snapshot.activeJob.logLines.forEach(function(line) {
        appendLogLineToPane(logPane, line);
      });
    }
  } else {
    clearActiveJob();
  }

  var tickets = snapshot.pendingTickets || [];
  updatePendingCount(tickets.length);
  renderQueueFromTickets(tickets);
}

// ── Worker status ─────────────────────────────────────────────────────────────

function updateWorkerStatus(status) {
  currentWorkerStatus = status;
  var dot   = document.getElementById('status-dot');
  var label = document.getElementById('status-label');
  var sub   = document.getElementById('status-sub');
  var btn   = document.getElementById('toggle-btn');

  dot.className = 'status-dot';
  btn.className = 'status-btn';

  if (status === 'running') {
    dot.classList.add('running');
    label.textContent = 'Running';
    sub.textContent   = 'polling for tickets';
    btn.textContent   = 'Stop';
  } else if (status === 'stopped') {
    dot.classList.add('stopped');
    label.textContent = 'Stopped';
    sub.textContent   = 'worker paused';
    btn.textContent   = 'Start';
    btn.classList.add('start');
  } else {
    label.textContent = 'Idle';
    sub.textContent   = 'worker ready';
    btn.textContent   = 'Start';
    btn.classList.add('start');
  }
}

// ── Active job ────────────────────────────────────────────────────────────────

function showActiveJob(job) {
  currentJob = job;
  var card    = document.getElementById('active-card');
  var pill    = document.getElementById('job-pill');
  var body    = document.getElementById('job-body');
  var actions = document.getElementById('job-header-actions');

  card.className = 'active-job-card running';

  // Pill
  pill.className = 'pill pill-running';
  pill.textContent = '';
  var dot = document.createElement('span');
  dot.className = 'pill-dot';
  pill.appendChild(dot);
  pill.appendChild(document.createTextNode('Running'));

  // Body
  clearElement(body);

  var jobId = document.createElement('div');
  jobId.className = 'job-id';
  jobId.textContent = job.identifier;
  body.appendChild(jobId);

  var jobTitle = document.createElement('div');
  jobTitle.className = 'job-title';
  jobTitle.textContent = job.title;
  body.appendChild(jobTitle);

  // Stage track
  var track = document.createElement('div');
  track.className = 'stage-track';

  var preCls, agentCls, postCls, preTxt, agentTxt, postTxt;
  if (job.stage === 'pre-hook') {
    preCls = 'stage-step active'; preTxt = '\u25B6 pre-hooks';
    agentCls = 'stage-step'; agentTxt = 'agent';
    postCls = 'stage-step'; postTxt = 'post-hooks';
  } else if (job.stage === 'post-hook') {
    preCls = 'stage-step done'; preTxt = '\u2713 pre-hooks';
    agentCls = 'stage-step done'; agentTxt = '\u2713 agent';
    postCls = 'stage-step active'; postTxt = '\u25B6 post-hooks';
  } else {
    // executor (default)
    preCls = 'stage-step done'; preTxt = '\u2713 pre-hooks';
    agentCls = 'stage-step active'; agentTxt = '\u25B6 agent';
    postCls = 'stage-step'; postTxt = 'post-hooks';
  }

  var stageSteps = [
    { id: 'stage-pre',   cls: preCls,   txt: preTxt   },
    { id: 'stage-agent', cls: agentCls, txt: agentTxt },
    { id: 'stage-post',  cls: postCls,  txt: postTxt  }
  ];
  stageSteps.forEach(function(s) {
    var step = document.createElement('div');
    step.id = s.id;
    step.className = s.cls;
    step.textContent = s.txt;
    track.appendChild(step);
  });
  body.appendChild(track);

  // Log pane
  var logPane = document.createElement('div');
  logPane.className = 'log-pane';
  logPane.id = 'log-pane';
  body.appendChild(logPane);

  // Cancel button
  clearElement(actions);
  var cancelBtn = document.createElement('button');
  cancelBtn.className = 'cancel-btn';
  cancelBtn.textContent = '\u2715 Cancel';
  cancelBtn.addEventListener('click', function() {
    fetch('/api/job/cancel', { method: 'POST' });
  });
  actions.appendChild(cancelBtn);
}

function updateJobStage(stage) {
  var pre   = document.getElementById('stage-pre');
  var agent = document.getElementById('stage-agent');
  var post  = document.getElementById('stage-post');
  if (!pre || !agent || !post) return;

  if (stage === 'pre-hook') {
    pre.className = 'stage-step active'; pre.textContent = '\u25B6 pre-hooks';
    agent.className = 'stage-step';      agent.textContent = 'agent';
    post.className  = 'stage-step';      post.textContent  = 'post-hooks';
  } else if (stage === 'executor') {
    pre.className   = 'stage-step done'; pre.textContent   = '\u2713 pre-hooks';
    agent.className = 'stage-step active'; agent.textContent = '\u25B6 agent';
    post.className  = 'stage-step';      post.textContent  = 'post-hooks';
  } else if (stage === 'post-hook') {
    pre.className   = 'stage-step done'; pre.textContent   = '\u2713 pre-hooks';
    agent.className = 'stage-step done'; agent.textContent = '\u2713 agent';
    post.className  = 'stage-step active'; post.textContent = '\u25B6 post-hooks';
  }
}

function appendLogLine(line) {
  var logPane = document.getElementById('log-pane');
  if (!logPane) return;
  appendLogLineToPane(logPane, line);
}

function appendLogLineToPane(pane, text) {
  // Remove old blinking cursor
  var oldCursor = pane.querySelector('.cursor');
  if (oldCursor) oldCursor.remove();

  var div = document.createElement('div');
  var cls = 'log-line';
  var t = (text || '').toLowerCase();
  if (t.indexOf('[claude]') !== -1)            cls += ' claude';
  else if (t.indexOf('[error]') !== -1 || t.indexOf('error:') !== -1) cls += ' err';
  else if (t.indexOf('\u2713') !== -1 || t.indexOf(' ok') !== -1) cls += ' ok';
  else if (t.charAt(0) === '[')                cls += ' system';
  div.className = cls;
  div.textContent = text;
  pane.appendChild(div);

  // Trim to 10 lines
  while (pane.childElementCount > 10) pane.removeChild(pane.firstElementChild);

  // Add blinking cursor
  var cursor = document.createElement('span');
  cursor.className = 'cursor';
  div.appendChild(cursor);
}

function clearLogPane(pane) {
  while (pane.firstChild) pane.removeChild(pane.firstChild);
}

function handleJobEnd(event) {
  var card    = document.getElementById('active-card');
  var pill    = document.getElementById('job-pill');
  var actions = document.getElementById('job-header-actions');
  var post    = document.getElementById('stage-post');

  if (!event.success) {
    clearActiveJob();
    return;
  }

  if (event.prUrl) {
    // Review state
    card.className = 'active-job-card review';

    clearElement(pill);
    pill.className = 'pill pill-review';
    pill.textContent = '\u2713 Ready for Review';

    if (post) {
      post.className  = 'stage-step done-purple';
      post.textContent = '\u2713 post-hooks';
    }

    clearElement(actions);
    var wrap = document.createElement('div');
    wrap.className = 'review-actions';

    var prBtn = document.createElement('button');
    prBtn.className = 'review-btn review-btn-pr';
    prBtn.textContent = '\u2197 Open PR';
    var prUrl = event.prUrl; // capture in closure
    prBtn.addEventListener('click', function() {
      window.open(prUrl, '_blank', 'noopener,noreferrer');
    });

    var skipBtn = document.createElement('button');
    skipBtn.className = 'review-btn review-btn-skip';
    skipBtn.textContent = 'Dismiss';
    skipBtn.addEventListener('click', function() {
      fetch('/api/job/dismiss', { method: 'POST' });
    });

    wrap.appendChild(prBtn);
    wrap.appendChild(skipBtn);
    actions.appendChild(wrap);
  } else {
    clearActiveJob();
  }
}

function handleJobError(error) {
  appendLogLine('[error] ' + (error || 'unknown error'));
}

function clearActiveJob() {
  currentJob = null;
  var card    = document.getElementById('active-card');
  var pill    = document.getElementById('job-pill');
  var body    = document.getElementById('job-body');
  var actions = document.getElementById('job-header-actions');

  card.className = 'active-job-card';
  pill.className = 'pill pill-idle';
  pill.textContent = 'Idle';
  clearElement(actions);
  clearElement(body);

  var empty = document.createElement('div');
  empty.className = 'empty-job';
  var txt = document.createElement('div');
  txt.className = 'empty-text';
  txt.textContent = 'No active job';
  var sub = document.createElement('div');
  sub.className = 'empty-sub';
  sub.textContent = 'Worker will pick up next ticket on next poll';
  empty.appendChild(txt);
  empty.appendChild(sub);
  body.appendChild(empty);
}

// ── History ──────────────────────────────────────────────────────────────────

function addHistoryRow(row) {
  historyRows.unshift(row);
  if (historyRows.length > 50) historyRows.pop();

  statsProcessed++;
  if (row.status === 'done' || row.status === 'review') statsDoneCount++;
  updateStats();

  renderHistoryMini();
  renderHistoryFull();
  renderHistoryCount();
}

function renderHistoryMini() {
  var list = document.getElementById('history-mini-list');
  if (!list) return;
  clearElement(list);
  var recent = historyRows.slice(0, 5);
  if (recent.length === 0) {
    var empty = makeEmptyNote('No history yet');
    empty.style.padding = '20px';
    list.appendChild(empty);
    return;
  }
  recent.forEach(function(r) { list.appendChild(buildHistRowEl(r)); });
}

function renderHistoryFull() {
  var list = document.getElementById('history-full-list');
  if (!list) return;
  clearElement(list);
  if (historyRows.length === 0) {
    var row = document.createElement('div');
    row.className = 'hfrow';
    row.style.justifyContent = 'center';
    var sub = document.createElement('div');
    sub.className = 'empty-sub';
    sub.style.padding = '20px 0';
    sub.textContent = 'No history yet';
    row.appendChild(sub);
    list.appendChild(row);
    return;
  }
  historyRows.forEach(function(r) { list.appendChild(buildHfRowEl(r)); });
  renderHistoryCount();
}

function renderHistoryCount() {
  var el = document.getElementById('history-count');
  if (el) el.textContent = historyRows.length;
}

function buildHistRowEl(r) {
  var row = document.createElement('div');
  row.className = 'hist-row';

  var dot = document.createElement('div');
  dot.className = r.status === 'done' ? 'hdot hdot-ok' :
                  r.status === 'failed' ? 'hdot hdot-fail' : 'hdot hdot-review';
  row.appendChild(dot);

  var id = document.createElement('div');
  id.className = 'hist-id';
  id.textContent = r.identifier || '';
  row.appendChild(id);

  var title = document.createElement('div');
  title.className = 'hist-title';
  title.textContent = r.title || '';
  row.appendChild(title);

  var stage = document.createElement('div');
  stage.className = 'hist-stage';
  stage.textContent = r.status || '';
  row.appendChild(stage);

  var dur = document.createElement('div');
  dur.className = 'hist-dur';
  dur.textContent = fmtDur(r.durationMs);
  row.appendChild(dur);

  var time = document.createElement('div');
  time.className = 'hist-time';
  time.textContent = fmtTime(r.completedAt);
  row.appendChild(time);

  var tag = document.createElement('div');
  tag.className = r.status === 'done' ? 'htag htag-ok' :
                  r.status === 'failed' ? 'htag htag-fail' : 'htag htag-review';
  tag.textContent = r.status || '';
  row.appendChild(tag);

  return row;
}

function buildHfRowEl(r) {
  var row = document.createElement('div');
  row.className = 'hfrow';

  var dot = document.createElement('div');
  dot.className = r.status === 'done' ? 'hdot hdot-ok' :
                  r.status === 'failed' ? 'hdot hdot-fail' : 'hdot hdot-review';
  row.appendChild(dot);

  var id = document.createElement('div');
  id.className = 'hist-id';
  id.textContent = r.identifier || '';
  row.appendChild(id);

  var title = document.createElement('div');
  title.className = 'hist-title';
  title.textContent = r.title || '';
  row.appendChild(title);

  // PR link or stage
  var stageEl = document.createElement('div');
  stageEl.className = 'hist-stage';
  if (r.prUrl) {
    var a = document.createElement('a');
    a.href = r.prUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = '\u2197 PR';
    a.style.cssText = 'color:var(--purple);text-decoration:none;font-size:10px;';
    stageEl.appendChild(a);
  }
  row.appendChild(stageEl);

  var dur = document.createElement('div');
  dur.className = 'hist-dur';
  dur.textContent = fmtDur(r.durationMs);
  row.appendChild(dur);

  var time = document.createElement('div');
  time.className = 'hist-time';
  time.textContent = fmtTime(r.completedAt);
  row.appendChild(time);

  var tag = document.createElement('div');
  tag.className = r.status === 'done' ? 'htag htag-ok' :
                  r.status === 'failed' ? 'htag htag-fail' : 'htag htag-review';
  tag.textContent = r.status || '';
  row.appendChild(tag);

  return row;
}

// ── Queue ─────────────────────────────────────────────────────────────────────

function updatePendingCount(count) {
  pendingCount = count;
  var badge = document.getElementById('badge-queue');
  if (badge) badge.textContent = count;
  var miniBadge = document.getElementById('queue-mini-badge');
  if (miniBadge) miniBadge.textContent = count + ' waiting';
  var countEl = document.getElementById('queue-count');
  if (countEl) countEl.textContent = count;
}

function renderQueueFromTickets(tickets) {
  var miniList = document.getElementById('queue-mini-list');
  if (miniList) {
    clearElement(miniList);
    if (tickets.length === 0) {
      var empty = makeEmptyNote('No tickets in queue');
      empty.style.padding = '20px';
      miniList.appendChild(empty);
    } else {
      tickets.slice(0, 5).forEach(function(t) {
        var item = document.createElement('div');
        item.className = 'queue-item';

        var qdot = document.createElement('div');
        qdot.className = 'q-dot dot-dim';
        item.appendChild(qdot);

        var qid = document.createElement('div');
        qid.className = 'q-id';
        qid.textContent = t.identifier || '';
        item.appendChild(qid);

        var qtitle = document.createElement('div');
        qtitle.className = 'q-title';
        qtitle.textContent = t.title || '';
        item.appendChild(qtitle);

        miniList.appendChild(item);
      });
    }
  }

  var tableBody = document.getElementById('queue-table-body');
  if (tableBody) {
    clearElement(tableBody);
    if (tickets.length === 0) {
      var row = document.createElement('div');
      row.className = 'qt-row';
      row.style.gridTemplateColumns = '1fr';
      row.style.justifyContent = 'center';
      var sub = document.createElement('div');
      sub.className = 'empty-sub';
      sub.style.padding = '10px 0';
      sub.textContent = 'No tickets waiting';
      row.appendChild(sub);
      tableBody.appendChild(row);
    } else {
      tickets.forEach(function(t) {
        var row = document.createElement('div');
        row.className = 'qt-row';

        var qid = document.createElement('div');
        qid.className = 'qt-id';
        qid.textContent = t.identifier || '';
        row.appendChild(qid);

        var qtitle = document.createElement('div');
        qtitle.className = 'qt-title';
        qtitle.textContent = t.title || '';
        row.appendChild(qtitle);

        var priCell = document.createElement('div');
        var badge = document.createElement('span');
        var pri = (t.priority || '').toLowerCase();
        badge.className = pri === 'urgent' ? 'pbadge p-urgent' :
                          pri === 'high'   ? 'pbadge p-high'   : 'pbadge p-normal';
        badge.textContent = t.priority || 'Normal';
        priCell.appendChild(badge);
        row.appendChild(priCell);

        var created = document.createElement('div');
        created.style.cssText = 'font-size:11px;color:var(--text2)';
        created.textContent = t.createdAt ? fmtRelTime(t.createdAt) : '—';
        row.appendChild(created);

        var actCell = document.createElement('div');
        actCell.className = 'qt-actions';
        row.appendChild(actCell);

        tableBody.appendChild(row);
      });
    }
  }
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function updateStats() {
  var procEl = document.getElementById('stat-processed');
  if (procEl) procEl.textContent = statsProcessed;

  var rateEl  = document.getElementById('stat-rate');
  var rateSub = document.getElementById('stat-rate-sub');
  if (rateEl) {
    clearElement(rateEl);
    if (statsProcessed === 0) {
      rateEl.textContent = '—';
      var u1 = document.createElement('span');
      u1.className = 'stat-unit';
      u1.textContent = '%';
      rateEl.appendChild(u1);
      if (rateSub) rateSub.textContent = 'no data yet';
    } else {
      var rate = Math.round((statsDoneCount / statsProcessed) * 100);
      rateEl.textContent = rate;
      var u2 = document.createElement('span');
      u2.className = 'stat-unit';
      u2.textContent = '%';
      rateEl.appendChild(u2);
      if (rateSub) rateSub.textContent = statsDoneCount + ' of ' + statsProcessed + ' completed';
    }
  }

  var avgEl = document.getElementById('stat-avg-dur');
  if (avgEl) {
    clearElement(avgEl);
    var count = Math.min(historyRows.length, 10);
    if (count === 0) {
      avgEl.textContent = '—';
    } else {
      var slice = historyRows.slice(0, count);
      var totalMs = slice.reduce(function(s, r) { return s + (r.durationMs || 0); }, 0);
      var avgMs = totalMs / count;
      var mins = Math.floor(avgMs / 60000);
      var secs = Math.floor((avgMs % 60000) / 1000);
      if (mins > 0) {
        avgEl.textContent = mins;
        var um = document.createElement('span'); um.className = 'stat-unit'; um.textContent = 'm';
        avgEl.appendChild(um);
        avgEl.appendChild(document.createTextNode(' ' + secs));
        var us = document.createElement('span'); us.className = 'stat-unit'; us.textContent = 's';
        avgEl.appendChild(us);
      } else {
        avgEl.textContent = secs;
        var us2 = document.createElement('span'); us2.className = 'stat-unit'; us2.textContent = 's';
        avgEl.appendChild(us2);
      }
    }
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────

var viewMeta = {
  dashboard: { title: 'Dashboard',  sub: 'Real-time view of your agent worker' },
  queue:     { title: 'Queue',      sub: 'Tickets waiting to be picked up' },
  history:   { title: 'History',    sub: 'Completed and failed runs' },
  config:    { title: 'Settings',   sub: 'Configure agent-worker' }
};

document.querySelectorAll('.nav-item').forEach(function(el) {
  el.addEventListener('click', function() {
    var v = el.getAttribute('data-view');
    document.querySelectorAll('.content').forEach(function(c) { c.classList.remove('active'); });
    document.querySelectorAll('.nav-item').forEach(function(n) { n.classList.remove('active'); });
    var t = document.getElementById('view-' + v);
    if (t) t.classList.add('active');
    el.classList.add('active');
    var m = viewMeta[v];
    if (m) {
      document.getElementById('page-title').textContent = m.title;
      document.getElementById('page-sub').textContent = m.sub;
    }
  });
});

// ── Worker toggle ─────────────────────────────────────────────────────────────

document.getElementById('toggle-btn').addEventListener('click', function() {
  if (currentWorkerStatus === 'running') {
    fetch('/api/worker/stop', { method: 'POST' });
  } else {
    fetch('/api/worker/start', { method: 'POST' });
  }
});

// ── Refresh ──────────────────────────────────────────────────────────────────

document.getElementById('refresh-btn').addEventListener('click', function() {
  fetch('/api/state').then(function(r) { return r.json(); }).then(populateFromSnapshot);
});

// ── Settings form ─────────────────────────────────────────────────────────────

function populateSettingsForm(config) {
  lastConfig = config;
  if (!config) return;

  var linear   = config.linear   || {};
  var executor = config.executor || {};
  var hooks    = config.hooks    || {};
  var log      = config.log      || {};
  var repo     = config.repo     || {};

  setVal('cfg-project-id',         linear.project_id);
  setVal('cfg-poll-interval',      linear.poll_interval_seconds);
  setVal('cfg-status-ready',       (linear.statuses || {}).ready);
  setVal('cfg-status-in-progress', (linear.statuses || {}).in_progress);
  setVal('cfg-status-done',        (linear.statuses || {}).done);
  setVal('cfg-status-failed',      (linear.statuses || {}).failed);

  setVal('cfg-executor-type',  executor.type);
  setVal('cfg-timeout',        executor.timeout_seconds);
  setVal('cfg-repo-path',      repo.path);
  setVal('cfg-log-file',       log.file);

  setRetry(executor.retries || 0);

  renderHooksList('post-hooks-list', hooks.post || []);
  renderHooksList('pre-hooks-list',  hooks.pre  || []);
}

function setVal(id, val) {
  var el = document.getElementById(id);
  if (!el || val === undefined || val === null) return;
  el.value = val;
}

function renderHooksList(listId, cmds) {
  var list = document.getElementById(listId);
  if (!list) return;
  clearElement(list);
  cmds.forEach(function(cmd) { appendHookItem(list, cmd); });
}

function appendHookItem(list, cmd) {
  var item = document.createElement('div');
  item.className = 'hook-item';

  var text = document.createElement('span');
  text.className = 'hook-item-text';
  text.textContent = cmd;

  var rem = document.createElement('button');
  rem.className = 'hook-remove';
  rem.textContent = '\u2715';
  rem.addEventListener('click', function() { item.remove(); });

  item.appendChild(text);
  item.appendChild(rem);
  list.appendChild(item);
}

function serializeForm() {
  return {
    linear: {
      project_id: getVal('cfg-project-id'),
      poll_interval_seconds: parseInt(getVal('cfg-poll-interval')) || 60,
      statuses: {
        ready:       getVal('cfg-status-ready'),
        in_progress: getVal('cfg-status-in-progress'),
        done:        getVal('cfg-status-done'),
        failed:      getVal('cfg-status-failed')
      }
    },
    executor: {
      type:            getVal('cfg-executor-type'),
      timeout_seconds: parseInt(getVal('cfg-timeout')) || 300,
      retries:         retryVal
    },
    repo: {
      path: getVal('cfg-repo-path')
    },
    hooks: {
      pre:  getHooks('pre-hooks-list'),
      post: getHooks('post-hooks-list')
    },
    log: {
      file: getVal('cfg-log-file') || null
    }
  };
}

function getVal(id) {
  var el = document.getElementById(id);
  return el ? el.value.trim() : '';
}

function getHooks(listId) {
  var list = document.getElementById(listId);
  if (!list) return [];
  return Array.from(list.querySelectorAll('.hook-item-text'))
    .map(function(el) { return el.textContent.trim(); })
    .filter(Boolean);
}

async function saveSettings() {
  var config = serializeForm();
  var errEl  = document.getElementById('config-error');
  errEl.style.display = 'none';

  var res = await fetch('/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config)
  });

  if (!res.ok) {
    var err  = await res.json();
    var msgs = err.errors || [err.error || 'Unknown error'];
    errEl.textContent = Array.isArray(msgs) ? msgs.join('\n') : msgs;
    errEl.style.display = 'block';
  } else {
    lastConfig = config;
    errEl.style.display = 'none';
  }
}

document.getElementById('save-btn').addEventListener('click', saveSettings);

document.getElementById('discard-btn').addEventListener('click', function() {
  if (lastConfig) populateSettingsForm(lastConfig);
});

// ── YAML preview ──────────────────────────────────────────────────────────────

document.getElementById('yaml-toggle-btn').addEventListener('click', function() {
  var el  = document.getElementById('yaml-preview');
  var btn = document.getElementById('yaml-toggle-btn');
  if (el.style.display === 'none') {
    el.textContent = jsyaml.dump(serializeForm(), { indent: 2 });
    el.style.display = 'block';
    btn.textContent = '';
    btn.appendChild(document.createTextNode('Hide YAML '));
    var arrow = document.createElement('span');
    arrow.textContent = '\u25B2';
    btn.appendChild(arrow);
  } else {
    el.style.display = 'none';
    btn.textContent = '';
    btn.appendChild(document.createTextNode('View YAML '));
    var arrow2 = document.createElement('span');
    arrow2.textContent = '\u25BC';
    btn.appendChild(arrow2);
  }
});

// Live-update YAML when config form changes (if panel is open)
document.getElementById('view-config').addEventListener('input', function() {
  var el = document.getElementById('yaml-preview');
  if (el && el.style.display !== 'none') {
    el.textContent = jsyaml.dump(serializeForm(), { indent: 2 });
  }
});

// ── Retry stepper ─────────────────────────────────────────────────────────────

function setRetry(val) {
  retryVal = val;
  document.querySelectorAll('.retry-dot').forEach(function(d) {
    var dv = parseInt(d.getAttribute('data-val'));
    d.classList.toggle('on', dv <= val && val > 0);
  });
  var labels = ['none', '1 retry', '2 retries', '3 retries'];
  var lbl = document.getElementById('retry-label');
  if (lbl) lbl.textContent = labels[val] || 'none';
}

// ── Num stepper ───────────────────────────────────────────────────────────────

function stepNum(btn, amount) {
  var input = btn.closest('.num-field').querySelector('input');
  var min = parseInt(input.min) || 0;
  var max = parseInt(input.max) || 9999;
  input.value = Math.max(min, Math.min(max, (parseInt(input.value) || min) + amount));
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

function removeHook(btn) {
  btn.closest('.hook-item').remove();
}

function addHook(listId) {
  var cmd = prompt('Command:');
  if (!cmd || !cmd.trim()) return;
  var list = document.getElementById(listId);
  appendHookItem(list, cmd.trim());
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function clearElement(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

function makeEmptyNote(msg) {
  var wrap = document.createElement('div');
  wrap.className = 'empty-job';
  var sub = document.createElement('div');
  sub.className = 'empty-sub';
  sub.textContent = msg;
  wrap.appendChild(sub);
  return wrap;
}

function fmtDur(ms) {
  if (!ms && ms !== 0) return '—';
  var s = Math.floor(ms / 1000);
  var m = Math.floor(s / 60);
  s = s % 60;
  return m > 0 ? m + 'm ' + s + 's' : s + 's';
}

function fmtTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtRelTime(ts) {
  if (!ts) return '—';
  var diff = Date.now() - new Date(ts).getTime();
  var mins = Math.floor(diff / 60000);
  var hrs  = Math.floor(mins / 60);
  if (hrs > 0)  return hrs + 'h ago';
  if (mins > 0) return mins + 'm ago';
  return 'just now';
}

function showError(errors) {
  var errEl = document.getElementById('config-error');
  if (!errEl) return;
  errEl.textContent = Array.isArray(errors) ? errors.join('\n') : String(errors);
  errEl.style.display = 'block';
}
