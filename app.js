(function () {
  'use strict';

  const LIMITS = Object.freeze({
    rows: 2000, matches: 2000, companies: 32, quotes: 10000, pageSize: 200
  });

  function createStore() {
    return { matches: new Map(), rows: new Map(), companies: [],
      invalidCount: 0, capacityCount: 0, quoteCount: 0 };
  }

  function copyPrices(prices, sides) {
    if (!prices || typeof prices !== 'object') return null;
    const result = {};
    for (const side of sides) {
      const value = prices[side];
      result[side] = typeof value === 'string' && 32 >= value.length ? value : '';
    }
    return result;
  }

  function getMovement(previousDecimal, nextDecimal) {
    const previous = Number(previousDecimal);
    const next = Number(nextDecimal);
    if (!Number.isFinite(previous) || !Number.isFinite(next) ||
        !(previous > 1) || !(next > 1) || previous === next) {
      return '';
    }
    return next > previous ? 'up' : 'down';
  }

  function formatLine(line, market) {
    const value = Number(line.value);
    const quarters = value * 4;
    const split = Number.isInteger(quarters) && quarters % 2 !== 0;
    const text = split
      ? String(value - 0.25) + ' / ' + String(value + 0.25)
      : String(value);
    if (market !== 'handicap' || value === 0) return text;
    return (line.hc === 'H' ? '主让 ' : '客让 ') + text;
  }

  function ingestEvent(store, event, receivedAt) {
    function invalid() {
      store.invalidCount += 1;
      return 'invalid';
    }
    function capacity() {
      store.capacityCount = Math.min(Number.MAX_SAFE_INTEGER, store.capacityCount + 1);
      return 'capacity';
    }
    if (!event || event.version !== 5 ||
        typeof event.game_id !== 'string' || !event.game_id.trim() ||
        event.game_id.length > 256 ||
        typeof event.sys_time !== 'string' ||
        event.sys_time.length > 64 ||
        !Number.isFinite(Date.parse(event.sys_time))) {
      return invalid();
    }
    if (event.sport_code !== 'FT') return 'ignored';
    const eventTime = Date.parse(event.sys_time);
    if (event.event === 'matchInfo') {
      const required = ['league_code', 'league', 'home_num', 'home',
        'away_num', 'away', 'start_time'];
      if (!required.every(field =>
        typeof event[field] === 'string' && event[field].trim() &&
          256 >= event[field].length) ||
          typeof event.live_period_text !== 'string' ||
          event.live_period_text.length > 256 ||
          !['score_home', 'score_away'].every(field =>
            event[field] === null || Number.isInteger(event[field])) ||
          !['today', 'running', 'early', null].includes(event.game_type)) {
        return invalid();
      }
      const previous = store.matches.get(event.game_id);
      if (previous && Date.parse(previous.sys_time) > eventTime) return 'ignored';
      if (!previous && store.matches.size >= LIMITS.matches) return capacity();
      const info = { receivedAt };
      for (const field of [...required, 'version', 'event', 'sport_code',
        'game_id', 'game_type', 'sys_time', 'score_home', 'score_away',
        'live_period_text']) {
        info[field] = event[field];
      }
      store.matches.set(event.game_id, info);
      return 'accepted';
    }
    if (
        !['handicap', 'totals'].includes(event.market) ||
        !['full_time', 'first_half'].includes(event.period)) {
      return 'ignored';
    }
    const sides = event.market === 'handicap' ? ['home', 'away'] : ['over', 'under'];
    if (event.event !== 'oddsInfo' ||
        typeof event.odds_id !== 'string' || !event.odds_id.trim() ||
        event.odds_id.length > 256 ||
        !['today', 'running', 'early', null].includes(event.game_type) ||
        !event.decimal_odds || !sides.every(side =>
          typeof event.decimal_odds[side] === 'string' &&
            32 >= event.decimal_odds[side].length) ||
        typeof event.company_name !== 'string' || !event.company_name.trim() ||
        event.company_name.length > 256 ||
        !event.line || typeof event.line.value !== 'string' ||
        event.line.value.length > 32 ||
        !event.line.value.trim() ||
        !Number.isFinite(Number(event.line.value)) ||
        !(Number(event.line.value) >= 0) ||
        (event.market === 'handicap' && Number(event.line.value) !== 0 &&
          !['H', 'C'].includes(event.line.hc))) {
      return invalid();
    }
    const value = String(Number(event.line.value));
    const direction = event.market === 'handicap' && Number(value) !== 0
      ? event.line.hc : '';
    const key = JSON.stringify([event.game_id, event.game_type, event.period,
      event.market, value, direction]);
    let row = store.rows.get(key);
    if (!row && store.rows.size >= LIMITS.rows) return capacity();
    if (!store.companies.includes(event.company_name) &&
        store.companies.length >= LIMITS.companies) return capacity();
    if ((!row || !row.quotes.has(event.company_name)) &&
        store.quoteCount >= LIMITS.quotes) return capacity();
    if (!row) {
      row = { gameId: event.game_id, gameType: event.game_type,
        period: event.period, market: event.market,
        line: { value, hc: direction || null }, quotes: new Map() };
      store.rows.set(key, row);
    }
    const previous = row.quotes.get(event.company_name);
    if (previous && Date.parse(previous.sys_time) > eventTime) return 'ignored';
    const movements = {};
    for (const side of sides) {
      const before = previous && previous.decimal_odds[side];
      const after = event.decimal_odds[side];
      const direction = getMovement(before, after);
      const unchanged = previous && Number(before) > 1 &&
        Number(before) === Number(after);
      movements[side] = direction
        ? { direction, until: receivedAt + 3000 }
        : unchanged ? previous.movements[side] : { direction: '', until: 0 };
    }
    const quote = {
      odds_id: event.odds_id, game_id: event.game_id,
      game_type: event.game_type, period: event.period, market: event.market,
      company_name: event.company_name, sys_time: event.sys_time,
      decimal_odds: copyPrices(event.decimal_odds, sides),
      hk_odds: copyPrices(event.hk_odds, sides),
      ml_odds: copyPrices(event.ml_odds, sides),
      receivedAt, movements
    };
    row.quotes.set(event.company_name, quote);
    if (!previous) store.quoteCount += 1;
    if (!store.companies.includes(event.company_name)) {
      store.companies.push(event.company_name);
    }
    return 'accepted';
  }

  function selectRows(store, filters) {
    return Array.from(store.rows.values()).filter(row =>
      row.market === filters.market && row.period === filters.period &&
      (filters.gameType === 'all' || row.gameType === filters.gameType))
      .map(row => ({ ...row, match: store.matches.get(row.gameId) || null }))
      .sort((a, b) => {
        const leagueA = a.match
          ? a.match.league_code || a.match.league : '待补充联赛';
        const leagueB = b.match
          ? b.match.league_code || b.match.league : '待补充联赛';
        return leagueA.localeCompare(leagueB, 'zh-CN') ||
          a.gameId.localeCompare(b.gameId) ||
          String(a.gameType || '').localeCompare(String(b.gameType || '')) ||
          Number(a.line.value) - Number(b.line.value) ||
          String(a.line.hc || '').localeCompare(String(b.line.hc || ''));
      });
  }

  function initPage() {
    const store = createStore();
    const byId = id => document.getElementById(id);
    const companyOrder = ['皇冠', '利记', '澳门', '皇冠D', 'Ibet', 'M8bet',
      '平博API', '平博', '沙巴', '马会', '198Bet', 'Aliba', '96Bet', '虎扑'];
    const leagueColors = ['#16934e', '#268cab', '#7561b8', '#aa6a29',
      '#b14c73', '#3f7b9a', '#648a39', '#936650'];
    let renderPending = false;
    let expiryTimer = null;
    let state = 'disconnected';
    let lastMessage = null;
    let pageIndex = 0;
    const formatTime = timestamp => new Date(timestamp).toLocaleTimeString('zh-CN',
      { hour12: false });

    function element(tag, text, className) {
      const node = document.createElement(tag);
      if (text !== undefined && text !== null) node.textContent = text;
      if (className) node.className = className;
      return node;
    }

    function scheduleRender() {
      if (renderPending) return;
      renderPending = true;
      requestAnimationFrame(() => {
        renderPending = false;
        renderTable();
      });
    }

    function renderTable() {
      if (expiryTimer !== null) clearTimeout(expiryTimer);
      expiryTimer = null;
      const market = byId('market').value;
      const rows = selectRows(store, {
        market, period: byId('period').value, gameType: byId('game-type').value
      });
      const format = byId('odds-format').value;
      const pageCount = Math.max(1, Math.ceil(rows.length / LIMITS.pageSize));
      pageIndex = Math.max(0, Math.min(pageIndex, pageCount - 1));
      const start = pageIndex * LIMITS.pageSize;
      const visibleRows = rows.slice(start, start + LIMITS.pageSize);
      const companies = companyOrder.concat(
        store.companies.filter(name => !companyOrder.includes(name)));
      const head = element('tr');
      for (const name of ['序号', '联赛 / 比分', '时间', '球队', '盘口', ...companies]) {
        const th = element('th', name);
        th.scope = 'col';
        head.append(th);
      }
      byId('odds-head').replaceChildren(head);
      const body = document.createDocumentFragment();
      const now = Date.now();
      let nextExpiry = Infinity;
      visibleRows.forEach((row, index) => {
        const info = row.match;
        const tr = element('tr');
        tr.dataset.gameId = row.gameId;
        tr.append(element('td', start + index + 1));
        const league = element('td', null, 'league-cell');
        const leagueKey = info ? info.league_code || info.league : 'pending';
        let hash = 0;
        for (const character of leagueKey) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
        league.style.backgroundColor = leagueColors[hash % leagueColors.length];
        const leagueName = info ? info.league : '待补充联赛';
        league.title = leagueName;
        league.append(element('div', leagueName, 'league-name'));
        league.append(element('div', info
          ? String(info.score_home ?? '—') + ' – ' + String(info.score_away ?? '—')
          : '—', 'score'));
        tr.append(league);
        const time = element('td', info
          ? info.live_period_text || info.start_time : '—', 'match-time');
        if (info) time.title = info.start_time;
        tr.append(time);
        const teams = element('td');
        teams.append(element('div', info ? info.home : '比赛 ' + row.gameId, 'team-name team-home'),
          element('div', info ? info.away : '等待比赛信息', 'team-name'));
        tr.append(teams, element('td', formatLine(row.line, row.market), 'line-cell'));
        const sides = market === 'handicap' ? ['home', 'away'] : ['over', 'under'];
        for (const company of companies) {
          const cell = element('td', null, 'odds-cell');
          cell.dataset.company = company;
          const quote = row.quotes.get(company);
          if (quote) cell.title = '最近更新：' + formatTime(quote.receivedAt);
          for (const side of sides) {
            const raw = quote && quote[format] && quote[format][side];
            const available = typeof raw === 'string' && raw.trim() !== '' &&
              Number.isFinite(Number(raw)) && Number(quote.decimal_odds[side]) > 1;
            const price = element('div', available ? raw : '—',
              available ? 'price' : 'price price-missing');
            price.dataset.side = side;
            const movement = quote && quote.movements[side];
            if (available && movement && movement.direction && movement.until > now) {
              price.classList.add('price-' + movement.direction);
              nextExpiry = Math.min(nextExpiry, movement.until);
            }
            cell.append(price);
          }
          tr.append(cell);
        }
        body.append(tr);
      });
      byId('odds-body').replaceChildren(body);
      byId('row-count').textContent = rows.length + ' 条盘口';
      byId('page-number').textContent = '第 ' + (pageIndex + 1) + ' / ' + pageCount + ' 页';
      byId('previous-page').disabled = pageIndex === 0;
      byId('next-page').disabled = pageIndex + 1 >= pageCount;
      byId('capacity-note').hidden = store.capacityCount === 0;
      if (store.capacityCount) {
        byId('capacity-note').textContent =
          '已达到页面缓存上限，部分新盘口未收录；已有报价仍继续更新。' +
          '需要重新收集时请刷新页面并重新连接。';
      }
      byId('side-hint').textContent = market === 'handicap'
        ? '赔率上方：主队 · 下方：客队' : '赔率上方：大球 · 下方：小球';
      byId('invalid-count').textContent = String(store.invalidCount);
      const empty = byId('empty-state');
      empty.hidden = rows.length > 0;
      if (!rows.length) {
        const title = store.rows.size ? '当前筛选暂无数据'
          : state === 'connected' ? '已连接，等待新数据' : '等待连接行情';
        const detail = store.rows.size ? '切换市场、阶段或比赛类型，查看已收到的报价。'
          : state === 'connected' ? '接口只推送连接后的事件，首次显示可能需要等待。'
            : '在上方输入 API Key，点击“连接行情”。';
        empty.replaceChildren(element('strong', title), element('p', detail));
      }
      if (Number.isFinite(nextExpiry)) {
        expiryTimer = setTimeout(scheduleRender, Math.max(1, nextExpiry - Date.now() + 5));
      }
    }

    const client = createConnection({
      WebSocketCtor: window.WebSocket,
      setTimer: window.setTimeout.bind(window),
      clearTimer: window.clearTimeout.bind(window),
      random: Math.random,
      onState(nextState, details = {}) {
        state = nextState;
        const labels = {
          disconnected: '已断开', connecting: '连接中', connected: '已连接',
          reconnecting: '重连中 · ' + Math.ceil((details.delay || 0) / 1000) + ' 秒后重试',
          'auth-failed': 'Key 或会员权限无效', 'taken-over': '连接已被其他客户端接管'
        };
        byId('connection-state').textContent = labels[state] || '未连接';
        byId('connection-state').dataset.state = state;
        byId('connection-note').textContent =
          state === 'auth-failed' ? '请检查 Key 与会员权限，重新输入后连接。'
            : state === 'taken-over' ? '为避免重复连接，已停止重试；需要时可手动连接。'
              : state === 'connected' ? '正在接收新事件。旧报价保留，悬停查看更新时间。'
                : '原表保留，报价可能陈旧；收到新事件后更新，不补发断线期间的数据。';
        scheduleRender();
      },
      onEvent(event) {
        lastMessage = Date.now();
        byId('last-message').textContent = formatTime(lastMessage);
        const result = ingestEvent(store, event, lastMessage);
        if (result !== 'ignored') scheduleRender();
        return result;
      },
      onInvalid() {
        store.invalidCount += 1;
        byId('invalid-count').textContent = String(store.invalidCount);
      }
    });
    byId('api-key').value = '';
    byId('connection-form').addEventListener('submit', event => {
      event.preventDefault();
      const key = byId('api-key').value;
      client.connect(key);
      byId('api-key').value = '';
    });
    byId('disconnect').addEventListener('click', () => client.disconnect());
    for (const id of ['market', 'period', 'game-type', 'odds-format']) {
      byId(id).addEventListener('change', () => {
        pageIndex = 0;
        scheduleRender();
      });
    }
    byId('previous-page').addEventListener('click', () => {
      pageIndex = Math.max(0, pageIndex - 1);
      scheduleRender();
    });
    byId('next-page').addEventListener('click', () => {
      pageIndex += 1;
      scheduleRender();
    });
    window.addEventListener('pagehide', () => {
      client.disconnect();
      byId('api-key').value = '';
      if (expiryTimer !== null) clearTimeout(expiryTimer);
    });
    renderTable();
  }

  function createConnection(options) {
    const { WebSocketCtor, setTimer, clearTimer, random,
      onState, onEvent, onInvalid } = options;
    let socket = null;
    let timer = null;
    let deadline = null;
    let generation = 0;
    let key = '';
    let failures = 0;
    let stopped = true;

    function clearDeadline() {
      if (deadline !== null) clearTimer(deadline);
      deadline = null;
    }

    function cancel() {
      generation += 1;
      if (timer !== null) clearTimer(timer);
      timer = null;
      clearDeadline();
      const previous = socket;
      socket = null;
      if (previous) previous.close();
    }

    function retry(currentGeneration) {
      if (stopped || generation !== currentGeneration) return;
      const base = Math.min(30000, 1000 * 2 ** Math.min(failures, 5));
      const delay = Math.min(30000, Math.round(base * (0.9 + random() * 0.2)));
      failures = Math.min(failures + 1, 6);
      onState('reconnecting', { delay });
      timer = setTimer(() => {
        timer = null;
        if (!stopped && generation === currentGeneration) open();
      }, delay);
    }

    function open() {
      if (stopped) return;
      const currentGeneration = ++generation;
      onState('connecting');
      let current;
      try {
        current = new WebSocketCtor(
          'wss://footballai.shop/ws/market/realtime?api_key=' +
          encodeURIComponent(key));
      } catch {
        retry(currentGeneration);
        return;
      }
      socket = current;
      const isCurrent = () => !stopped &&
        generation === currentGeneration && socket === current;

      current.onopen = () => {
        if (!isCurrent()) return;
        clearDeadline();
        onState('connected');
      };
      current.onmessage = message => {
        if (!isCurrent()) return;
        if (typeof message.data !== 'string' || message.data.length > 65536) {
          onInvalid();
          return;
        }
        let event;
        try {
          event = JSON.parse(message.data);
        } catch {
          onInvalid();
          return;
        }
        if (onEvent(event) === 'accepted') failures = 0;
      };
      current.onerror = () => {
        // The close event owns retry scheduling; never expose a socket URL.
      };
      current.onclose = event => {
        if (!isCurrent()) return;
        clearDeadline();
        socket = null;
        if (event.code === 1008 || event.code === 4001) {
          stopped = true;
          key = '';
          onState(event.code === 1008 ? 'auth-failed' : 'taken-over');
          return;
        }
        retry(currentGeneration);
      };
      deadline = setTimer(() => {
        deadline = null;
        if (!isCurrent()) return;
        socket = null;
        current.close();
        retry(currentGeneration);
      }, 15000);
    }

    function connect(input) {
      stopped = true;
      cancel();
      key = typeof input === 'string' ? input.trim() : '';
      failures = 0;
      if (!key) {
        onState('auth-failed');
        return;
      }
      stopped = false;
      open();
    }

    function disconnect() {
      stopped = true;
      cancel();
      key = '';
      onState('disconnected');
    }

    return { connect, disconnect };
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { createStore, ingestEvent, selectRows, getMovement,
      formatLine, createConnection, LIMITS };
  }
  if (typeof document !== 'undefined') initPage();
}());
