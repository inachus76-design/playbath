
(() => {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const blank = () => ({people:[], entries:{}, settings:{...defaults}});
  const legacy = clone(state);
  const saveLocal = persist;
  const scanLocal = onScan;
  let username = '', revision = -1, applying = false, ready = false;
  let queued = null, failed = false, conflicted = false, local = false, switching = false;
  const panel = document.createElement('section');
  const main = $('list').parentElement;
  panel.style.cssText = 'margin:12px auto;padding:14px;border:1px solid #c7e7dc;border-radius:16px;background:#f3fcf9;color:#23443e;max-width:1060px';
  panel.innerHTML = '<details><summary>교사 계정 · 기기 간 공유</summary>' +
    '<form autocomplete="on"><label>교사 아이디 <input name="username" autocomplete="username" minlength="3" maxlength="40" required></label> ' +
    '<label>비밀번호 <input name="password" type="password" autocomplete="current-password" minlength="12" maxlength="128" required></label> ' +
    '<button type="submit" data-auth-submit>로그인</button> <button type="button" data-action="enroll">계정 등록</button> ' +
    '<p data-registration-help hidden>아이디는 영문 소문자 또는 숫자로 시작하는 3~40자이며, 마침표·밑줄·하이픈을 사용할 수 있습니다. 비밀번호는 12~128자입니다.</p></form>' +
    '<div class="toolbar"><button type="button" data-action="local">이 기기 명단 사용</button> ' +
    '<button type="button" data-action="copy" hidden>이 기기의 기존 명단 복사</button> ' +
    '<button type="button" data-action="retry" hidden>다시 저장</button> ' +
    '<button type="button" data-action="reload" hidden>최신 내용 불러오기</button> ' +
    '<button type="button" data-action="logout" hidden>로그아웃</button></div>' +
    '<div role="status" aria-live="polite"></div></details>';
  main.insertBefore(panel, $('list'));
  const details = panel.querySelector('details');
  const form = panel.querySelector('form');
  const status = panel.querySelector('[role=status]');
  const control = action => panel.querySelector('[data-action="' + action + '"]');
  const notify = message => { status.textContent = message; };
  const navigation = [...document.querySelectorAll('[data-page]')];
  const panels = [...document.querySelectorAll('.panel')];
  const submitButton = form.querySelector('[data-auth-submit]');
  const registrationHelp = form.querySelector('[data-registration-help]');
  let registering = false;
  function setRegistration(enabled) {
    registering = enabled;
    registrationHelp.hidden = !enabled;
    submitButton.textContent = enabled ? '등록 완료' : '로그인';
    control('enroll').textContent = enabled ? '로그인 화면으로' : '계정 등록';
    form.elements.password.autocomplete = enabled ? 'new-password' : 'current-password';
  }
  function controls() {
    form.hidden = !!username;
    control('copy').hidden = !username || !legacy.people.length;
    control('logout').hidden = !username;
    control('local').hidden = !!username || local;
    control('retry').hidden = !username || !failed || conflicted;
    control('reload').hidden = !username || !conflicted;
    panel.querySelector('summary').textContent = username ? username + ' · 공유 모드' :
      local ? '교사 계정 · 이 기기 모드' : '교사 계정 · 기기 간 공유';
    for (const element of [...navigation, ...panels]) element.inert = !ready || switching || conflicted;
    $('list').querySelector('.hint').textContent = username ? '같은 교사 계정으로 로그인한 기기에서 명단을 공유합니다. 유아 이름을 수정해도 입장권은 유지됩니다.' : '이 기기의 브라우저에 저장합니다. 이름을 수정해도 입장권은 유지됩니다.';
    if (conflicted || failed) details.open = true;
  }
  function show(next, {reset = false, settings = false} = {}) {
    state = next || blank();
    state.settings = {...defaults, ...state.settings};
    state.entries = Object.assign(Object.create(null), state.entries);
    $('appTitle').textContent = state.settings.bathName;
    if (reset) {
      closeWelcome();
      stopCamera();
      selected.clear();
      $('printArea').replaceChildren();
      $('ticketGrid').replaceChildren();
      $('enteredList').replaceChildren();
      $('remainingList').replaceChildren();
      $('welcomeName').textContent = '';
      $('welcomeMessage').textContent = '';
      $('welcomeSub').textContent = '';
      $('singleName').value = '';
      $('bulkNames').value = '';
      page('list');
    }
    const active = document.querySelector('.panel.active')?.id;
    if (active === 'list') renderPeople();
    if (active === 'tickets') renderTickets();
    if (active === 'status') renderStatus();
    if (active === 'settings' && settings) loadSettings();
  }
  async function request(action, method = 'GET', data) {
    const res = await fetch('/api/bath/' + action, {
      method, cache:'no-store', credentials:'same-origin',
      ...(method === 'GET' ? {} : {headers:{'Content-Type':'application/json'}, body:JSON.stringify(data || {})})
    });
    let payload;
    try { payload = await res.json(); } catch { throw Error('공유 저장소에 연결할 수 없습니다.'); }
    if (!res.ok) throw Object.assign(Error(payload.error || '공유 저장소를 사용할 수 없습니다.'), {status:res.status});
    return payload;
  }
  function leaveCloud(message) {
    username = '';
    revision = -1;
    queued = null;
    failed = conflicted = false;
    ready = local = false;
    show(blank(), {reset:true});
    details.open = true;
    notify(message);
    controls();
  }
  async function refresh(initial = false) {
    const result = await request('state');
    if (!initial && (queued || applying || switching || conflicted || result.username !== username || result.version <= revision)) return;
    username = result.username;
    revision = result.version;
    ready = true;
    show(result.state, {reset:initial});
    if (initial) {
      details.open = true;
      notify(legacy.people.length && !result.state?.people.length ?
        '이 기기의 명단을 옮기려면 기존 명단 복사 버튼을 누르세요.' : '같은 계정으로 로그인한 기기에서 명단과 입장 기록을 확인할 수 있습니다.');
    }
    local = false;
    controls();
  }
  async function flush() {
    if (applying || conflicted || switching || !queued || !username) return false;
    applying = true;
    failed = false;
    notify('공유 저장 중입니다.');
    try {
      while (queued) {
        const pending = queued;
        queued = null;
        try {
          const result = await request('state', 'PUT', {version:revision, state:pending});
          revision = result.version;
        } catch (error) {
          queued ??= pending;
          throw error;
        }
      }
      notify('공유 저장이 완료되었습니다.');
      return true;
    } catch (error) {
      failed = true;
      conflicted = error.status === 409 || error.status === 401;
      notify(error.status === 401 ? '로그인이 만료되었습니다. 최신 내용 불러오기를 선택하면 다시 로그인할 수 있습니다.' :
        ((error.message || '연결 오류') + (conflicted ? '' : ' 다시 저장을 눌러 주세요.')));
      return false;
    } finally {
      applying = false;
      controls();
    }
  }
  window.addEventListener('beforeunload', event => {
    if (!queued && !applying) return;
    event.preventDefault();
    event.returnValue = '';
  });
  persist = () => {
    if (local) {
      Object.assign(legacy, clone(state));
      return saveLocal();
    }
    if (!username || conflicted) return;
    queued = clone(state);
    if (!failed) return flush();
  };
  onScan = async code => {
    if (local) return scanLocal(code);
    if (!username || applying || queued || conflicted || switching) return;
    if (scanBusy || !code.startsWith(QR_PREFIX)) return scanLocal(code);
    const id = code.slice(QR_PREFIX.length);
    const person = state.people.find(item => item.id === id);
    if (!person) return scanLocal(code);
    if (Object.hasOwn(state.entries, id)) return scanLocal(code);
    scanBusy = true;
    state.entries[id] = new Date().toISOString();
    if (await persist()) showWelcome(person, false);
    else {
      scanBusy = false;
      scanMessage('입장 기록을 확인하려면 교사 계정의 저장 상태를 확인해 주세요.');
    }
  };
  const saveSettingsLocal = $('saveSettings').onclick;
  $('saveSettings').onclick = async () => {
    if (local) return saveSettingsLocal();
    state.settings = {
      bathName: $('bathName').value.trim() || defaults.bathName,
      welcomeText: $('welcomeText').value.trim() || defaults.welcomeText,
      welcomeSeconds: Math.min(120, Math.max(0, Number($('welcomeSeconds').value) || 0)),
      voiceOn: $('voiceOn').checked, soundOn: $('soundOn').checked,
      voiceRate: Number($('voiceRate').value), voiceVolume: Number($('voiceVolume').value)
    };
    $('appTitle').textContent = state.settings.bathName;
    await persist();
  };
  control('enroll').onclick = () => {
    if (switching || username) return;
    setRegistration(!registering);
    form.elements.username.focus();
  };
  form.onsubmit = async event => {
    event.preventDefault();
    if (switching || username) return;
    const register = registering;
    switching = true;
    controls();
    try {
      await request(register ? 'register' : 'login', 'POST', {
        username:form.elements.username.value,
        password:form.elements.password.value
      });
      form.reset();
      setRegistration(false);
      await refresh(true);
    } catch (error) { notify(error.message || (register ? '계정 등록에 실패했습니다.' : '로그인에 실패했습니다.')); }
    finally { switching = false; controls(); }
  };
  control('local').onclick = () => {
    if (switching || username) return;
    ready = local = true;
    show(clone(legacy), {reset:true});
    notify('이 기기의 브라우저에 저장합니다.');
    controls();
  };
  control('copy').onclick = () => {
    if (applying || queued || conflicted || !username) return;
    const existing = new Set(state.people.map(item => item.id));
    const additions = legacy.people.filter(item => !existing.has(item.id));
    if (!additions.length) return notify('현재 계정에 같은 고유번호의 명단이 이미 있습니다.');
    if (state.people.length + additions.length > 1000) return notify('명단은 최대 1,000명까지 저장할 수 있습니다.');
    if (!confirm('이 기기의 유아 명단 ' + additions.length + '명을 교사 계정에 복사할까요? 기존 입장권은 계속 사용할 수 있습니다.')) return;
    state.people.push(...clone(additions));
    renderPeople();
    persist();
  };
  control('retry').onclick = flush;
  control('reload').onclick = async () => {
    if (applying || switching || !confirm('이번에 저장하지 못한 변경을 버리고 공유 저장소의 최신 내용을 불러올까요?')) return;
    switching = true;
    controls();
    try {
      await refresh(true);
      queued = null;
      failed = conflicted = false;
    } catch (error) {
      if (error.status === 401) leaveCloud('로그인이 만료되었습니다. 다시 로그인해 주세요.');
      else notify(error.message);
    } finally { switching = false; controls(); }
  };
  control('logout').onclick = async () => {
    if (applying || queued || switching) return notify('저장 상태를 먼저 확인해 주세요.');
    switching = true;
    controls();
    try {
      await request('logout', 'POST');
      leaveCloud('로그아웃했습니다.');
    } catch (error) { notify(error.message); }
    finally { switching = false; controls(); }
  };
  const poll = () => {
    if (!username || applying || queued || switching || document.hidden) return;
    refresh().catch(error => {
      if (error.status === 401 && !applying && !queued) leaveCloud('로그인이 만료되었습니다. 다시 로그인해 주세요.');
    });
  };
  document.addEventListener('visibilitychange', poll);
  setInterval(poll, 5000);
  switching = true;
  leaveCloud('교사 계정으로 로그인해 주세요.');
  refresh(true).catch(error => {
    if (error.status !== 401) notify(error.message);
  }).finally(() => { switching = false; controls(); });
})();
