/**
 * Roster - a shared team roster, open to anyone with the link.
 *
 * Its own public Apps Script project (access ANYONE_ANONYMOUS). The page lives
 * on GitHub Pages and talks to this over a GET JSON API (?api=fn&args=[...]).
 * GET, not POST: a cross-origin POST to /exec 302s to a target that answers 405.
 *
 * Identity: there is none for viewers. Writes that change the roster need the
 * manager PIN (hashed, stored in meta, never sent to the client). Leave
 * REQUESTS need no PIN so staff can raise them from the link; approving one
 * does. Storage is one script property per month of shifts so each stays well
 * under the 9KB value cap and edits in different months never contend.
 */

var VERSION = 'v1.0';
var META = 'ros:meta';
var LEAVE = 'ros:leave';
var MONTH = 'ros:m:';
var DAY = /^\d{4}-\d{2}-\d{2}$/;
var MON = /^\d{4}-\d{2}$/;
var CODES = { AM: 1, PM: 1, PE: 1, OFF: 1 };

var FEEDBACK = 'ros:feedback';
var AGENT = 'ros:agentkey';
var PUBLIC_API = {
  getState: 1, setup: 1, checkPin: 1, setShifts: 1, saveStaff: 1, saveSettings: 1,
  requestLeave: 1, decideLeave: 1, withdrawLeave: 1, changePin: 1,
  listFeedback: 1, submitFeedback: 1, updateFeedback: 1, claimAgent: 1
};

function doGet(e) {
  var p = (e && e.parameter) || {};
  var out;
  try {
    if (!p.api) { out = { ok: true, result: { version: VERSION, hint: 'Use ?api=getState&args=[]' } }; }
    else if (!PUBLIC_API[p.api]) throw new Error('Unknown call: ' + p.api);
    else out = { ok: true, result: this[p.api].apply(null, JSON.parse(p.args || '[]')) };
  } catch (err) {
    out = { ok: false, error: err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

function props() { return PropertiesService.getScriptProperties(); }
function readJson(key, dflt) {
  var raw = props().getProperty(key);
  if (!raw) return dflt;
  try { return JSON.parse(raw); } catch (err) { return dflt; }
}
function withLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { return fn(); } finally { lock.releaseLock(); }
}
function sha(s) {
  var b = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8);
  return b.map(function (x) { x = (x + 256) % 256; return (x < 16 ? '0' : '') + x.toString(16); }).join('');
}
function id() { return Utilities.getUuid().slice(0, 8); }

function defaultMeta() {
  return {
    staff: [],
    settings: { am: ['08:00', '16:00'], pm: ['17:00', '22:00'], pe: ['17:00', '20:00'], team: 'Roster' },
    pinHash: null,
    updated: new Date().toISOString()
  };
}
function readMeta() { return readJson(META, null); }
function writeMeta(m) { m.updated = new Date().toISOString(); props().setProperty(META, JSON.stringify(m)); }
function publicMeta(m) {
  return { staff: m.staff, settings: m.settings, ready: !!m.pinHash, updated: m.updated, version: VERSION };
}
function requirePin(pin) {
  var m = readMeta();
  if (!m || !m.pinHash) throw new Error('Roster not set up yet');
  if (sha(String(pin || '')) !== m.pinHash) throw new Error('Wrong PIN');
  return m;
}
function cleanName(s) { return String(s || '').replace(/[<>]/g, '').trim().slice(0, 40); }

/** Everything the page needs for the given months (["2026-09", ...]). */
function getState(months) {
  var m = readMeta() || defaultMeta();
  var fb = readJson(FEEDBACK, []);
  var shifts = {};
  (months || []).slice(0, 6).forEach(function (mo) {
    if (MON.test(mo)) shifts[mo] = readJson(MONTH + mo, {});
  });
  return { meta: publicMeta(m), shifts: shifts, leave: readJson(LEAVE, []), feedback: fb };
}

/** First run: names the staff and sets the manager PIN. Only works once. */
function setup(pin, names, team) {
  return withLock(function () {
    var m = readMeta() || defaultMeta();
    if (m.pinHash) throw new Error('Already set up');
    pin = String(pin || '');
    if (pin.length < 4) throw new Error('PIN needs at least 4 characters');
    m.pinHash = sha(pin);
    m.staff = (names || []).map(cleanName).filter(Boolean).slice(0, 12).map(function (n) { return { id: id(), name: n }; });
    if (team) m.settings.team = cleanName(team);
    writeMeta(m);
    return publicMeta(m);
  });
}

function checkPin(pin) { requirePin(pin); return true; }

function changePin(pin, next) {
  return withLock(function () {
    var m = requirePin(pin);
    next = String(next || '');
    if (next.length < 4) throw new Error('PIN needs at least 4 characters');
    m.pinHash = sha(next);
    writeMeta(m);
    return true;
  });
}

/**
 * Apply a batch of cell edits: [{date, staffId, code}] where code is AM, PM,
 * PE (PM finishing 8pm), OFF, or null to clear. Grouped by month so each
 * property is read and written once.
 */
function setShifts(pin, changes) {
  return withLock(function () {
    var m = requirePin(pin);
    var ids = {};
    m.staff.forEach(function (s) { ids[s.id] = 1; });
    var byMonth = {};
    (changes || []).forEach(function (c) {
      if (!DAY.test(c.date)) throw new Error('Bad date ' + c.date);
      if (!ids[c.staffId]) throw new Error('Unknown staff');
      if (c.code !== null && c.code !== undefined && !CODES[c.code]) throw new Error('Bad shift ' + c.code);
      (byMonth[c.date.slice(0, 7)] = byMonth[c.date.slice(0, 7)] || []).push(c);
    });
    var out = {};
    Object.keys(byMonth).forEach(function (mo) {
      var blob = readJson(MONTH + mo, {});
      byMonth[mo].forEach(function (c) {
        var day = blob[c.date] || {};
        if (c.code) day[c.staffId] = c.code; else delete day[c.staffId];
        if (Object.keys(day).length) blob[c.date] = day; else delete blob[c.date];
      });
      props().setProperty(MONTH + mo, JSON.stringify(blob));
      out[mo] = blob;
    });
    return out;
  });
}

/** Replace the staff list. Existing ids keep their shifts; new entries get ids. */
function saveStaff(pin, staff) {
  return withLock(function () {
    var m = requirePin(pin);
    var list = (staff || []).map(function (s) {
      return { id: /^[\w-]{4,12}$/.test(s.id || '') ? s.id : id(), name: cleanName(s.name) };
    }).filter(function (s) { return s.name; }).slice(0, 12);
    if (!list.length) throw new Error('Need at least one person');
    m.staff = list;
    writeMeta(m);
    return publicMeta(m);
  });
}

function saveSettings(pin, settings) {
  return withLock(function () {
    var m = requirePin(pin);
    var T = /^\d{2}:\d{2}$/;
    ['am', 'pm', 'pe'].forEach(function (k) {
      var v = settings && settings[k];
      if (v && T.test(v[0]) && T.test(v[1])) m.settings[k] = [v[0], v[1]];
    });
    if (settings && settings.team) m.settings.team = cleanName(settings.team);
    writeMeta(m);
    return publicMeta(m);
  });
}

/** Anyone on the link can raise a request; it waits for the manager. */
function requestLeave(staffId, from, to, note) {
  return withLock(function () {
    var m = readMeta();
    if (!m || !m.staff.some(function (s) { return s.id === staffId; })) throw new Error('Unknown staff');
    if (!DAY.test(from) || !DAY.test(to) || to < from) throw new Error('Bad dates');
    var list = readJson(LEAVE, []);
    if (list.length >= 200) list = list.filter(function (l) { return l.status === 'pending' || l.to >= from; }).slice(-150);
    var req = { id: id(), staffId: staffId, from: from, to: to, note: cleanName(note).slice(0, 80),
                status: 'pending', at: new Date().toISOString() };
    list.push(req);
    props().setProperty(LEAVE, JSON.stringify(list));
    return list;
  });
}

/** Manager approves or declines. Approving clears any shifts on those days. */
function decideLeave(pin, leaveId, status) {
  return withLock(function () {
    requirePin(pin);
    if (status !== 'approved' && status !== 'declined') throw new Error('Bad status');
    var list = readJson(LEAVE, []);
    var req = list.filter(function (l) { return l.id === leaveId; })[0];
    if (!req) throw new Error('Request not found');
    req.status = status;
    req.decided = new Date().toISOString();
    props().setProperty(LEAVE, JSON.stringify(list));
    if (status === 'approved') {
      var d = new Date(req.from + 'T00:00:00Z'), end = new Date(req.to + 'T00:00:00Z');
      var byMonth = {};
      while (d <= end) {
        var iso = d.toISOString().slice(0, 10);
        (byMonth[iso.slice(0, 7)] = byMonth[iso.slice(0, 7)] || []).push(iso);
        d.setUTCDate(d.getUTCDate() + 1);
      }
      Object.keys(byMonth).forEach(function (mo) {
        var blob = readJson(MONTH + mo, {}), dirty = false;
        byMonth[mo].forEach(function (iso) {
          if (blob[iso] && blob[iso][req.staffId]) {
            delete blob[iso][req.staffId]; dirty = true;
            if (!Object.keys(blob[iso]).length) delete blob[iso];
          }
        });
        if (dirty) props().setProperty(MONTH + mo, JSON.stringify(blob));
      });
    }
    return list;
  });
}

/** Pending requests can be withdrawn by anyone (small team); decided ones need the PIN. */
function withdrawLeave(leaveId, pin) {
  return withLock(function () {
    var list = readJson(LEAVE, []);
    var req = list.filter(function (l) { return l.id === leaveId; })[0];
    if (!req) throw new Error('Request not found');
    if (req.status !== 'pending') requirePin(pin);
    list = list.filter(function (l) { return l.id !== leaveId; });
    props().setProperty(LEAVE, JSON.stringify(list));
    return list;
  });
}

/* ---------------- feedback: change requests, worked off by an agent ---------------- */

function listFeedback() { return readJson(FEEDBACK, []); }

/** Anyone on the link can ask for a change. Status starts as 'new'. */
function submitFeedback(name, text) {
  return withLock(function () {
    text = String(text || '').replace(/[<>]/g, '').trim().slice(0, 1200);
    if (text.length < 3) throw new Error('Say a little more');
    var list = readJson(FEEDBACK, []);
    if (list.length >= 60) list = list.filter(function (f) { return f.status !== 'done'; }).concat(list.filter(function (f) { return f.status === 'done'; }).slice(-20));
    list.push({ id: id(), name: cleanName(name), text: text, status: 'new', at: new Date().toISOString(), reply: '' });
    props().setProperty(FEEDBACK, JSON.stringify(list));
    return list;
  });
}

/** The first caller sets the agent key; after that it only confirms a match. */
function claimAgent(key) {
  return withLock(function () {
    key = String(key || '');
    if (key.length < 16) throw new Error('Key too short');
    var cur = props().getProperty(AGENT);
    if (!cur) { props().setProperty(AGENT, sha(key)); return 'claimed'; }
    if (cur !== sha(key)) throw new Error('Not the agent');
    return 'ok';
  });
}

/** The agent (or the manager with the PIN) moves a request along and leaves a reply. */
function updateFeedback(key, feedbackId, status, reply) {
  return withLock(function () {
    var cur = props().getProperty(AGENT);
    var isAgent = cur && cur === sha(String(key || ''));
    if (!isAgent) requirePin(key);
    if (['new', 'working', 'done', 'declined'].indexOf(status) < 0) throw new Error('Bad status');
    var list = readJson(FEEDBACK, []);
    var f = list.filter(function (x) { return x.id === feedbackId; })[0];
    if (!f) throw new Error('Not found');
    f.status = status;
    if (reply !== undefined && reply !== null) f.reply = String(reply).replace(/[<>]/g, '').slice(0, 600);
    f.updated = new Date().toISOString();
    props().setProperty(FEEDBACK, JSON.stringify(list));
    return list;
  });
}
