// ==UserScript==
// @name         打开指定博主链接并且获取最近指定篇数文章并且进行访问可循环
// @namespace    yjlio.csdn.autovisit.v2
// @version      2.5.0
// @description  获取博主文章，自定义选择区间或手动勾选，阅读量检测与过滤，支持自动收藏和循环，并发批量访问
// @match        https://blog.csdn.net/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      blog.csdn.net
// ==/UserScript==

(() => {
  'use strict';

  // ── 文章页：自动收藏 ─────────────────────────────────────
  const COLLECT_TS_KEY = 'av_collect_trigger_ts';
  const COLLECT_WIN_MS = 25_000;

  async function runCollectOnArticlePage() {
    const ts = await GM_getValue(COLLECT_TS_KEY, 0);
    if (!ts || Date.now() - ts > COLLECT_WIN_MS) return;
    await sleep(2500);
    const SELS = [
      '.tool-box .btn-collect-box', '.tool-box [class*="collect"]',
      '#collect-btn', '.btn-collect', '[data-type="collect"]', '.toolbox-list .icon-collect',
    ];
    let btn = null;
    for (const s of SELS) { const el = document.querySelector(s); if (el) { btn = el; break; } }
    if (!btn) return;
    const cls = btn.className || '';
    if (cls.includes('active') || cls.includes('collected') || btn.getAttribute('aria-pressed') === 'true') return;
    btn.click(); await sleep(800);
    for (const s of ['.collect-dialog .el-button--primary', '.el-dialog__footer .el-button--primary']) {
      const el = document.querySelector(s); if (el) { el.click(); break; }
    }
  }
  if (/\/article\/details\/\d+/.test(location.pathname)) { runCollectOnArticlePage(); }

  // ── 工具 ─────────────────────────────────────────────────
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function $(sel, root = document) { return root.querySelector(sel); }
  function fmtNum(n) {
    if (n >= 10000) return (n / 10000).toFixed(1) + 'w';
    if (n >= 1000)  return (n / 1000).toFixed(1) + 'k';
    return String(n);
  }
  function extractUsername(url) {
    try { return new URL(url.trim()).pathname.split('/').filter(Boolean)[0] || ''; } catch { return ''; }
  }

  // ── API ──────────────────────────────────────────────────
  function apiGet(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url,
        headers: { 'User-Agent': navigator.userAgent, 'Referer': 'https://blog.csdn.net/', 'Accept': 'application/json' },
        onload(res) {
          if (res.status !== 200) return reject(new Error(`HTTP ${res.status}`));
          try { resolve(JSON.parse(res.responseText)); } catch { reject(new Error('JSON 解析失败')); }
        },
        onerror()  { reject(new Error('网络请求失败')); },
        ontimeout(){ reject(new Error('请求超时')); },
        timeout: 15000,
      });
    });
  }

  async function fetchAllArticles(username, onProgress, limit = 0) {
    const PAGE_SIZE = 20;
    const links = [], metas = [];
    let page = 1, total = Infinity;

    while (links.length < total) {
      if (limit > 0 && links.length >= limit) break;
      const json = await apiGet(
        `https://blog.csdn.net/community/home-api/v1/get-business-list` +
        `?page=${page}&size=${PAGE_SIZE}&businessType=blog&username=${encodeURIComponent(username)}`
      );
      if (json.code !== 200 || !json.data) throw new Error(`API 返回异常: code=${json.code}`);
      const { list = [], total: apiTotal = 0 } = json.data;
      if (page === 1) { total = apiTotal; if (!total) break; }

      for (const item of list) {
        if (limit > 0 && links.length >= limit) break;
        const url = (item.url || '').split('?')[0].trim();
        if (!url || links.includes(url)) continue;
        links.push(url);
        const viewCount =
          item.viewCount ?? item.view_count ?? item.readCount ??
          item.read_count ?? item.digg ?? 0;
        metas.push({ viewCount: Number(viewCount) || 0, title: item.title || '' });
      }

      onProgress(links.length, limit > 0 ? Math.min(limit, total) : total);
      if (list.length < PAGE_SIZE) break;
      page++;
      await sleep(300);
    }
    return { links, metas };
  }

  // ── 控制器（并发批量版） ──────────────────────────────────
  class VisitController {
    constructor(onUpdate) {
      this.onUpdate = onUpdate;
      this.running  = false;
      this.aborted  = false;
      this.openedWins = [];
    }

    /**
     * @param {string[]}  links         - 要访问的 URL 数组
     * @param {number[]}  origIndices   - 对应原始列表中的下标（用于高亮）
     * @param {number}    visitSec      - 每批停留秒数
     * @param {boolean}   autoCollect   - 是否触发自动收藏
     * @param {boolean}   loop          - 是否循环
     * @param {number}    batchSize     - 每批并发打开的标签数（默认5）
     */
    async start(links, origIndices, visitSec, autoCollect, loop = false, batchSize = 5) {
      this.running = true;
      this.aborted = false;
      let round = 1;
      this.onUpdate({ phase: 'start', loop, batchSize });

      do {
        // 按 batchSize 切片
        for (let bStart = 0; bStart < links.length && !this.aborted; bStart += batchSize) {
          const bEnd      = Math.min(bStart + batchSize, links.length);
          const bLinks    = links.slice(bStart, bEnd);
          const bOrigIdx  = origIndices.slice(bStart, bEnd);

          // 触发收藏标记（仅对批次首篇，因为收藏是在新页面里自动跑的）
          await GM_setValue(COLLECT_TS_KEY, autoCollect ? Date.now() : 0);

          this.onUpdate({
            phase: 'opening',
            batchLinks: bLinks,
            batchOrigIndices: bOrigIdx,
            batchStart: bStart,
            batchEnd: bEnd - 1,
            total: links.length,
            round,
          });

          // 同时打开这一批
          this.openedWins = [];
          for (const url of bLinks) {
            if (this.aborted) break;
            const w = window.open(url, '_blank');
            if (w) this.openedWins.push(w);
          }

          // 等待 visitSec 秒（只等一次，不是每篇各等一次）
          for (let t = visitSec; t > 0 && !this.aborted; t--) {
            this.onUpdate({
              phase: 'countdown',
              remaining: t,
              total: visitSec,
              batchStart: bStart,
              batchEnd: bEnd - 1,
              totalLinks: links.length,
              round,
            });
            await sleep(1000);
          }

          // 统一关闭这一批
          for (const w of this.openedWins) {
            try { if (w && !w.closed) w.close(); } catch {}
          }
          this.openedWins = [];

          if (this.aborted) break;

          this.onUpdate({
            phase: 'closed',
            batchOrigIndices: bOrigIdx,
            batchStart: bStart,
            batchEnd: bEnd - 1,
            total: links.length,
            round,
          });

          // 批次间短暂间隔（远比原来的 1s × N 小）
          if (bEnd < links.length && !this.aborted) await sleep(400);
        }

        if (this.aborted) break;

        if (loop) {
          this.onUpdate({ phase: 'round_done', round, total: links.length });
          await sleep(1500);
          round++;
        }
      } while (loop && !this.aborted);

      await GM_setValue(COLLECT_TS_KEY, 0);
      this.running = false;
      this.onUpdate({ phase: this.aborted ? 'stopped' : 'done', round });
    }

    stop() {
      this.aborted = true; this.running = false;
      GM_setValue(COLLECT_TS_KEY, 0);
      for (const w of this.openedWins) {
        try { if (w && !w.closed) w.close(); } catch {}
      }
      this.openedWins = [];
    }
  }

  // ── UI ───────────────────────────────────────────────────
  const PANEL_ID = 'csdn_av2_panel';
  const FAB_ID   = 'csdn_av2_fab';
  const CIRC     = 2 * Math.PI * 22;
  const DEFAULT_URL   = 'https://blog.csdn.net/weixin_47431459?type=blog';
  const DEFAULT_LIMIT = 100;

  function buildPanel() {
    if ($('#' + PANEL_ID)) return;

    const style = document.createElement('style');
    style.textContent = `
      #${PANEL_ID} *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;}
      #${PANEL_ID} input[type=text],#${PANEL_ID} input[type=number]{
        border:1px solid #e0e0e0;border-radius:8px;padding:6px 10px;
        font-size:13px;outline:none;background:#fafafa;color:#111;transition:.15s;width:100%;
      }
      #${PANEL_ID} input:focus{border-color:#1677ff;background:#fff;box-shadow:0 0 0 3px rgba(22,119,255,.12);}
      #${PANEL_ID} button{
        border:1px solid #ddd;border-radius:8px;padding:6px 12px;font-size:13px;
        cursor:pointer;background:#fff;color:#333;transition:.12s;white-space:nowrap;
      }
      #${PANEL_ID} button:hover:not(:disabled){background:#f5f5f5;}
      #${PANEL_ID} button:active:not(:disabled){transform:scale(.97);}
      #${PANEL_ID} button:disabled{opacity:.45;cursor:default;}
      #${PANEL_ID} .btn-blue{background:#1677ff;color:#fff;border-color:#1677ff;}
      #${PANEL_ID} .btn-blue:hover:not(:disabled){background:#0e60d4;}
      #${PANEL_ID} .btn-red{background:#ff4d4f;color:#fff;border-color:#ff4d4f;}
      #${PANEL_ID} .btn-red:hover:not(:disabled){background:#d9363e;}
      #${PANEL_ID} .btn-sm{padding:4px 9px;font-size:12px;}
      #${PANEL_ID} .tag{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;}
      #${PANEL_ID} .t-blue{background:#e6f4ff;color:#1677ff;}
      #${PANEL_ID} .t-green{background:#f6ffed;color:#389e0d;}
      #${PANEL_ID} .t-orange{background:#fff7e6;color:#d46b08;}
      #${PANEL_ID} .t-gray{background:#f5f5f5;color:#666;}
      #${PANEL_ID} .row{display:flex;align-items:center;gap:8px;}
      #${PANEL_ID} .sec-label{font-size:11px;font-weight:600;color:#999;letter-spacing:.3px;margin:0 0 5px;}
      #${PANEL_ID} .toggle-box{
        display:flex;align-items:center;gap:8px;padding:6px 10px;
        border-radius:8px;border:1px solid #e8e8e8;background:#fafafa;cursor:pointer;user-select:none;
      }
      #${PANEL_ID} .toggle-box:hover{border-color:#bbb;}
      #${PANEL_ID} .toggle-pill{width:30px;height:17px;border-radius:9px;background:#d0d0d0;position:relative;transition:.2s;flex-shrink:0;}
      #${PANEL_ID} .toggle-pill.on{background:#1677ff;}
      #${PANEL_ID} .toggle-knob{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:#fff;transition:.2s;}
      #${PANEL_ID} .toggle-pill.on .toggle-knob{left:15px;}
      #${PANEL_ID} .art-item{
        display:flex;align-items:center;gap:7px;padding:5px 8px;border-radius:6px;
        font-size:12px;margin-bottom:1px;user-select:none;
      }
      #${PANEL_ID} .art-item.active{background:#e6f4ff;}
      #${PANEL_ID} .art-item.in-batch{background:#f0e6ff;outline:1px solid #d3adf7;}
      #${PANEL_ID} .art-item.done{background:#f6ffed;}
      #${PANEL_ID} .art-item.selected{background:#f9f0ff;outline:1px solid #d3adf7;}
      #${PANEL_ID} .custom-mode .art-item{cursor:pointer;}
      #${PANEL_ID} .custom-mode .art-item:hover:not(.active):not(.done){background:#fafafa;outline:1px solid #ddd;}
      #${PANEL_ID} .art-idx{
        min-width:20px;height:20px;border-radius:50%;background:#f0f0f0;
        display:flex;align-items:center;justify-content:center;font-size:10px;color:#888;font-weight:600;flex-shrink:0;
      }
      #${PANEL_ID} .art-item.active   .art-idx{background:#1677ff;color:#fff;}
      #${PANEL_ID} .art-item.in-batch .art-idx{background:#722ed1;color:#fff;}
      #${PANEL_ID} .art-item.done     .art-idx{background:#52c41a;color:#fff;}
      #${PANEL_ID} .art-item.selected .art-idx{background:#722ed1;color:#fff;}
      #${PANEL_ID} .art-url{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#444;}
      #${PANEL_ID} .view-badge{font-size:10px;padding:1px 5px;border-radius:4px;flex-shrink:0;font-weight:600;}
      #${PANEL_ID} .view-badge.low {background:#f6ffed;color:#389e0d;}
      #${PANEL_ID} .view-badge.high{background:#fff1f0;color:#cf1322;}
      #${PANEL_ID} .custom-bar{border:1px solid #e8e8e8;border-radius:10px;padding:8px 10px;background:#fafafa;}
      #${PANEL_ID} .divider{border:none;border-top:1px dashed #e8e8e8;margin:8px 0;}
      #${PANEL_ID} .range-input{width:60px !important;text-align:center;padding:4px 6px !important;}
      #${PANEL_ID} .batch-hint{font-size:11px;color:#722ed1;background:#f9f0ff;border-radius:6px;padding:3px 8px;}
    `;
    document.head.appendChild(style);

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = [
      'position:fixed;z-index:2147483647;right:16px;top:70px',
      'width:430px;max-height:90vh',
      'border:1px solid #e5e5e5;border-radius:16px',
      'background:#fff;box-shadow:0 12px 40px rgba(0,0,0,.13)',
      'display:flex;flex-direction:column;overflow:hidden',
    ].join(';');

    panel.innerHTML = `
      <div id="av2_titlebar"
        style="padding:11px 14px;border-bottom:1px solid #f0f0f0;
               display:flex;align-items:center;gap:8px;cursor:move;user-select:none;">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
             stroke="#1677ff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M13 2L3 14h9l-1 8 10-12h-9z"/>
        </svg>
        <span style="font-weight:600;font-size:14px;flex:1;">CSDN 互访助手</span>
        <span id="av2_badge" class="tag t-gray">就绪</span>
        <button id="av2_close" style="border:0;background:0;padding:4px 6px;cursor:pointer;font-size:15px;color:#bbb;line-height:1;">✕</button>
      </div>

      <div style="flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:12px;">

        <!-- URL + 数量 -->
        <div>
          <p class="sec-label">博主主页链接</p>
          <div class="row" style="margin-bottom:8px;">
            <input id="av2_url" type="text" value="${DEFAULT_URL}" placeholder="https://blog.csdn.net/用户名"/>
          </div>
          <div class="row">
            <span style="font-size:12px;color:#666;flex-shrink:0;">获取数量</span>
            <input id="av2_limit" type="number" min="1" value="${DEFAULT_LIMIT}" placeholder="留空=全部"
              style="width:100px;flex-shrink:0;text-align:center;"/>
            <button id="av2_fetch" class="btn-blue" style="flex:1;">获取文章</button>
          </div>
          <div id="av2_fetch_progress"
            style="display:none;margin-top:8px;font-size:12px;color:#1677ff;background:#f0f8ff;border-radius:6px;padding:6px 10px;">
            正在获取… <b id="av2_fp_cur">0</b> / <b id="av2_fp_total">?</b> 篇
          </div>
        </div>

        <!-- 设置行 -->
        <div class="row" style="flex-wrap:wrap;gap:8px;">
          <!-- 停留时间 -->
          <div class="row" style="gap:5px;">
            <span style="font-size:12px;color:#666;white-space:nowrap;">每批停留</span>
            <input id="av2_sec" type="number" min="0.5" max="120" step="0.5" value="0.5"
              style="width:56px;text-align:center;"/>
            <span style="font-size:12px;color:#666;">秒</span>
          </div>
          <!-- 并发数 -->
          <div class="row" style="gap:5px;border:1px solid #e8e8e8;border-radius:8px;padding:5px 10px;background:#fafafa;">
            <span style="font-size:12px;color:#333;white-space:nowrap;">并发</span>
            <input id="av2_batch" type="number" min="1" max="20" value="5"
              style="width:44px;text-align:center;"/>
            <span style="font-size:12px;color:#666;">标签</span>
          </div>
          <!-- 自动收藏 -->
          <div id="av2_toggle" class="toggle-box">
            <div class="toggle-pill on" id="av2_toggle_pill"><div class="toggle-knob"></div></div>
            <span style="font-size:12px;color:#333;">自动收藏</span>
            <span id="av2_toggle_tip" class="tag t-blue">开启</span>
          </div>
          <!-- 循环 -->
          <div id="av2_loop_toggle" class="toggle-box">
            <div class="toggle-pill on" id="av2_loop_pill"><div class="toggle-knob"></div></div>
            <span style="font-size:12px;color:#333;">循环</span>
            <span id="av2_loop_tip"
              style="font-size:11px;color:#fa8c16;background:#fff7e6;padding:1px 6px;border-radius:10px;">开启</span>
          </div>
        </div>

        <!-- 效率预估 -->
        <div id="av2_efficiency"
          style="display:none;font-size:12px;padding:6px 10px;border-radius:8px;
                 background:#f9f0ff;border:1px solid #d3adf7;color:#531dab;">
          <span id="av2_eff_text"></span>
        </div>

        <!-- 文章列表 -->
        <div>
          <p class="sec-label">
            文章列表
            <span id="av2_count" style="font-weight:400;color:#bbb;margin-left:4px;"></span>
          </p>
          <div id="av2_list"
            style="max-height:210px;overflow-y:auto;border:1px solid #f0f0f0;
                   border-radius:10px;padding:6px;background:#fafafa;min-height:48px;">
            <div style="text-align:center;color:#ccc;padding:14px 0;font-size:13px;">
              请先点击「获取文章」
            </div>
          </div>
        </div>

        <!-- 自定义选择栏 -->
        <div class="custom-bar" id="av2_custom_bar">
          <div class="row">
            <label class="row" style="gap:6px;cursor:pointer;user-select:none;">
              <input type="checkbox" id="av2_custom_chk"
                style="width:14px;height:14px;cursor:pointer;accent-color:#722ed1;"/>
              <span style="font-size:13px;font-weight:600;color:#333;">自定义选择</span>
            </label>
            <span id="av2_sel_count"
              style="font-size:12px;color:#722ed1;display:none;margin-left:auto;">已选 0 篇</span>
          </div>
          <div id="av2_custom_controls" style="display:none;flex-direction:column;gap:8px;margin-top:10px;">
            <div class="row" style="gap:6px;flex-wrap:wrap;">
              <span style="font-size:12px;color:#555;flex-shrink:0;">区间：从第</span>
              <input id="av2_range_from" type="number" min="1" placeholder="1" class="range-input"/>
              <span style="font-size:12px;color:#555;">到第</span>
              <input id="av2_range_to"   type="number" min="1" placeholder="N" class="range-input"/>
              <span style="font-size:12px;color:#555;">篇</span>
              <button id="av2_apply_range" class="btn-sm" style="margin-left:auto;">应用区间</button>
              <button id="av2_clear_sel"   class="btn-sm" style="color:#999;">清空</button>
            </div>
            <div style="font-size:11px;color:#999;line-height:1.5;">
              点击单选 ·
              <kbd style="background:#f0f0f0;padding:1px 4px;border-radius:3px;font-size:10px;">Ctrl</kbd> 多选/取消 ·
              <kbd style="background:#f0f0f0;padding:1px 4px;border-radius:3px;font-size:10px;">Shift</kbd> 范围选
            </div>
            <hr class="divider"/>
            <div class="row" style="gap:6px;flex-wrap:wrap;">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#fa8c16"
                stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                <circle cx="12" cy="12" r="3"/>
              </svg>
              <span style="font-size:12px;color:#555;white-space:nowrap;">阅读量 &gt;</span>
              <input id="av2_view_threshold" type="number" min="0" value="10000"
                class="range-input" style="width:72px !important;"/>
              <button id="av2_show_views"  class="btn-sm">显示阅读量</button>
              <button id="av2_filter_views" class="btn-sm"
                style="color:#cf1322;border-color:#ffa39e;background:#fff1f0;"
                title="取消已选中且阅读量超过阈值的文章">取消超量选择</button>
            </div>
            <div id="av2_view_result"
              style="display:none;font-size:11px;padding:5px 8px;border-radius:6px;
                     background:#fff7e6;color:#d46b08;line-height:1.5;"></div>
          </div>
        </div>

        <!-- 进度区 -->
        <div id="av2_pbox"
          style="display:none;padding:12px;border:1px solid #e6f4ff;border-radius:10px;background:#f0f8ff;">
          <div class="row" style="gap:12px;align-items:center;">
            <div style="position:relative;width:52px;height:52px;flex-shrink:0;">
              <svg viewBox="0 0 52 52" style="width:52px;height:52px;">
                <circle cx="26" cy="26" r="22" fill="none" stroke="#e0e0e0" stroke-width="4"/>
                <circle id="av2_ring" cx="26" cy="26" r="22" fill="none"
                  stroke="#1677ff" stroke-width="4"
                  stroke-dasharray="${CIRC.toFixed(2)}" stroke-dashoffset="0"
                  stroke-linecap="round" transform="rotate(-90 26 26)"
                  style="transition:stroke-dashoffset .4s linear;"/>
              </svg>
              <div id="av2_cntdwn"
                style="position:absolute;inset:0;display:flex;align-items:center;
                       justify-content:center;font-size:14px;font-weight:700;color:#1677ff;">--</div>
            </div>
            <div style="flex:1;min-width:0;">
              <div id="av2_plabel" style="font-size:12px;color:#666;margin-bottom:3px;">准备中…</div>
              <div id="av2_purl"
                style="font-size:11px;color:#333;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">—</div>
              <div style="margin-top:3px;display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                <div id="av2_collect_state" style="font-size:11px;color:#52c41a;display:none;">✓ 已触发自动收藏</div>
                <div id="av2_round_badge"
                  style="font-size:11px;color:#fa8c16;background:#fff7e6;padding:1px 7px;border-radius:10px;display:none;">第 1 轮</div>
                <div id="av2_batch_badge"
                  style="font-size:11px;color:#722ed1;background:#f9f0ff;padding:1px 7px;border-radius:10px;display:none;"></div>
              </div>
            </div>
          </div>
          <div style="margin-top:10px;height:4px;border-radius:4px;background:#dde;overflow:hidden;">
            <div id="av2_bar" style="height:100%;background:#1677ff;border-radius:4px;width:0%;transition:width .4s;"></div>
          </div>
          <div id="av2_barlabel" style="margin-top:5px;font-size:11px;color:#888;text-align:right;">0 / 0</div>
        </div>

      </div>

      <div style="padding:10px 14px;border-top:1px solid #f0f0f0;display:flex;gap:8px;justify-content:flex-end;">
        <button id="av2_start" class="btn-blue" disabled>▶ 开始访问</button>
        <button id="av2_stop"  class="btn-red"  style="display:none;">⏹ 停止</button>
      </div>
    `;

    document.body.appendChild(panel);

    // ── 元素引用 ──
    const elUrl        = $('#av2_url',    panel);
    const elLimit      = $('#av2_limit',  panel);
    const elFetch      = $('#av2_fetch',  panel);
    const elFProg      = $('#av2_fetch_progress', panel);
    const elFPCur      = $('#av2_fp_cur', panel);
    const elFPTotal    = $('#av2_fp_total', panel);
    const elSec        = $('#av2_sec',    panel);
    const elBatch      = $('#av2_batch',  panel);
    const elEff        = $('#av2_efficiency', panel);
    const elEffText    = $('#av2_eff_text',   panel);
    const elList       = $('#av2_list',   panel);
    const elCount      = $('#av2_count',  panel);
    const elBadge      = $('#av2_badge',  panel);
    const elStart      = $('#av2_start',  panel);
    const elStop       = $('#av2_stop',   panel);
    const elPBox       = $('#av2_pbox',   panel);
    const elRing       = $('#av2_ring',   panel);
    const elCntdwn     = $('#av2_cntdwn', panel);
    const elPLabel     = $('#av2_plabel', panel);
    const elPUrl       = $('#av2_purl',   panel);
    const elCState     = $('#av2_collect_state', panel);
    const elBar        = $('#av2_bar',    panel);
    const elBarLbl     = $('#av2_barlabel', panel);
    const elClose      = $('#av2_close',  panel);
    const elToggle     = $('#av2_toggle', panel);
    const elTPill      = $('#av2_toggle_pill', panel);
    const elTTip       = $('#av2_toggle_tip',  panel);
    const elLoopToggle = $('#av2_loop_toggle', panel);
    const elLoopPill   = $('#av2_loop_pill',   panel);
    const elLoopTip    = $('#av2_loop_tip',    panel);
    const elRoundBadge = $('#av2_round_badge', panel);
    const elBatchBadge = $('#av2_batch_badge', panel);
    const elCustomChk  = $('#av2_custom_chk',     panel);
    const elCustomCtrl = $('#av2_custom_controls', panel);
    const elRangeFrom  = $('#av2_range_from',  panel);
    const elRangeTo    = $('#av2_range_to',    panel);
    const elApplyRange = $('#av2_apply_range', panel);
    const elClearSel   = $('#av2_clear_sel',   panel);
    const elSelCount   = $('#av2_sel_count',   panel);
    const elThreshold  = $('#av2_view_threshold', panel);
    const elShowViews  = $('#av2_show_views',  panel);
    const elFilterViews= $('#av2_filter_views',panel);
    const elViewResult = $('#av2_view_result', panel);

    // ── 效率预估 ──
    function updateEfficiency() {
      const n = articles.length || parseInt(elLimit.value, 10) || 100;
      const sec = parseFloat(elSec.value) || 0.5;
      const bs  = Math.max(1, parseInt(elBatch.value, 10) || 5);
      const batches = Math.ceil(n / bs);
      const totalSec = batches * (sec + 0.4); // 0.4 = 批次间隔
      const oldSec   = n * (sec + 1);          // 原串行：每篇 sec + 1s 间隔
      const speedup  = (oldSec / totalSec).toFixed(1);
      elEffText.textContent =
        `${n} 篇 / ${bs} 并发 = ${batches} 批，预计 ${totalSec.toFixed(0)}s`
        + (speedup > 1 ? `（比串行快约 ${speedup}×）` : '');
      elEff.style.display = articles.length || parseInt(elBatch.value) > 1 ? '' : 'none';
    }
    elBatch.addEventListener('input', updateEfficiency);
    elSec.addEventListener('input', updateEfficiency);

    // ── 开关 ──
    let autoCollect = true, loopMode = true;
    elToggle.onclick = () => {
      autoCollect = !autoCollect;
      elTPill.classList.toggle('on', autoCollect);
      elTTip.textContent = autoCollect ? '开启' : '关闭';
      elTTip.className   = autoCollect ? 'tag t-blue' : 'tag t-gray';
    };
    elLoopToggle.onclick = () => {
      loopMode = !loopMode;
      elLoopPill.classList.toggle('on', loopMode);
      elLoopTip.textContent      = loopMode ? '开启' : '关闭';
      elLoopTip.style.color      = loopMode ? '#fa8c16' : '#999';
      elLoopTip.style.background = loopMode ? '#fff7e6' : '#f5f5f5';
    };

    // ── 数据 ──
    let articles    = [];
    let articleMeta = [];
    let showViewMode = false;
    const doneSet   = new Set();
    let activeBatchSet = new Set(); // 当前批次中的原始下标

    // ── 自定义选择 ──
    let customMode  = false;
    let selectedSet = new Set();
    let lastClickIdx = -1;

    function updateSelCount() {
      const n = selectedSet.size;
      elSelCount.textContent   = `已选 ${n} 篇`;
      elSelCount.style.display = n > 0 ? '' : 'none';
    }

    elCustomChk.onchange = () => {
      customMode = elCustomChk.checked;
      elCustomCtrl.style.display = customMode ? 'flex' : 'none';
      if (!customMode) { selectedSet.clear(); lastClickIdx = -1; updateSelCount(); showViewMode = false; elViewResult.style.display = 'none'; }
      elList.classList.toggle('custom-mode', customMode);
      renderList();
    };

    elApplyRange.onclick = () => {
      if (!articles.length) return;
      const from = Math.max(1, parseInt(elRangeFrom.value, 10) || 1);
      const to   = Math.min(articles.length, parseInt(elRangeTo.value, 10) || articles.length);
      if (from > to) { alert(`区间错误：起始(${from}) 不能大于结束(${to})`); return; }
      selectedSet.clear();
      for (let i = from - 1; i <= to - 1; i++) selectedSet.add(i);
      lastClickIdx = to - 1;
      updateSelCount(); renderList(); updateEfficiency();
    };

    elClearSel.onclick = () => {
      selectedSet.clear(); lastClickIdx = -1;
      updateSelCount(); renderList(); elViewResult.style.display = 'none';
    };

    elShowViews.onclick = () => {
      if (!articles.length) { alert('请先获取文章列表'); return; }
      showViewMode = !showViewMode;
      elShowViews.textContent = showViewMode ? '隐藏阅读量' : '显示阅读量';
      elShowViews.style.background  = showViewMode ? '#e6f4ff' : '';
      elShowViews.style.color       = showViewMode ? '#1677ff' : '';
      elShowViews.style.borderColor = showViewMode ? '#91caff' : '';
      renderList();
    };

    elFilterViews.onclick = () => {
      if (!articles.length) { alert('请先获取文章列表'); return; }
      const threshold = parseInt(elThreshold.value, 10) || 10000;
      const overIndices = [...selectedSet].filter(i => (articleMeta[i]?.viewCount ?? 0) > threshold);
      if (overIndices.length === 0) {
        elViewResult.style.display = '';
        elViewResult.textContent   = `✅ 已选文章中没有阅读量超过 ${threshold.toLocaleString()} 的`;
        return;
      }
      overIndices.forEach(i => selectedSet.delete(i));
      updateSelCount(); renderList();
      elViewResult.style.display = '';
      elViewResult.innerHTML =
        `已取消 <b>${overIndices.length}</b> 篇高阅读量文章的选中` +
        `（阈值 ${threshold.toLocaleString()}），` +
        `剩余已选 <b>${selectedSet.size}</b> 篇`;
    };

    // ── 渲染文章列表 ──
    function renderList(scrollToOrigIdx = -1) {
      if (!articles.length) {
        elList.innerHTML = `<div style="text-align:center;color:#ccc;padding:14px 0;font-size:13px;">请先点击「获取文章」</div>`;
        return;
      }
      const threshold = parseInt(elThreshold.value, 10) || 10000;

      elList.innerHTML = articles.map((url, i) => {
        let cls = '';
        if (ctrl.running && activeBatchSet.has(i)) cls = 'in-batch';
        else if (doneSet.has(i))                   cls = 'done';
        else if (customMode && selectedSet.has(i)) cls = 'selected';

        let label;
        if (doneSet.has(i))                                   label = '✓';
        else if (ctrl.running && activeBatchSet.has(i))       label = '▶';
        else if (customMode && !ctrl.running && selectedSet.has(i)) label = '●';
        else                                                   label = i + 1;

        const short = url.replace('https://blog.csdn.net/', '').replace('/article/details/', ' #');
        let viewBadge = '';
        if (showViewMode && articleMeta[i] !== undefined) {
          const v = articleMeta[i].viewCount, hi = v > threshold;
          viewBadge = `<span class="view-badge ${hi ? 'high' : 'low'}" title="阅读量 ${v.toLocaleString()}">${hi ? '🔥' : ''}${fmtNum(v)}</span>`;
        }
        return `<div class="art-item ${cls}" data-idx="${i}">
          <div class="art-idx">${label}</div>
          <span class="art-url" title="${escHtml(url)}">${escHtml(short)}</span>
          ${viewBadge}
        </div>`;
      }).join('');

      if (customMode && !ctrl.running) {
        elList.querySelectorAll('.art-item').forEach(item => {
          item.addEventListener('click', onItemClick);
        });
      }
      if (scrollToOrigIdx >= 0) {
        elList.querySelectorAll('.art-item')[scrollToOrigIdx]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }

    function onItemClick(e) {
      const idx = parseInt(this.getAttribute('data-idx'));
      if (isNaN(idx)) return;
      if (e.shiftKey && lastClickIdx >= 0) {
        const from = Math.min(lastClickIdx, idx), to = Math.max(lastClickIdx, idx);
        for (let i = from; i <= to; i++) selectedSet.add(i);
      } else if (e.ctrlKey || e.metaKey) {
        if (selectedSet.has(idx)) selectedSet.delete(idx); else selectedSet.add(idx);
        lastClickIdx = idx;
      } else {
        selectedSet.clear(); selectedSet.add(idx); lastClickIdx = idx;
      }
      updateSelCount(); renderList(); updateEfficiency();
    }

    function setBadge(text, cls) { elBadge.textContent = text; elBadge.className = `tag ${cls}`; }
    function setProgress(done, total) {
      elBar.style.width    = total ? Math.round(done / total * 100) + '%' : '0%';
      elBarLbl.textContent = `${done} / ${total}`;
    }

    const ctrl = new VisitController(handleUpdate);

    function handleUpdate(ev) {
      const { phase } = ev || {};

      if (phase === 'start') {
        doneSet.clear(); activeBatchSet.clear();
        setBadge('运行中', 't-blue');
        elStart.style.display = 'none'; elStop.style.display = '';
        elFetch.disabled = true; elPBox.style.display = '';
        elRing.style.stroke = '#1677ff'; elCntdwn.textContent = '…';
        elCState.style.display = 'none';
        elRoundBadge.style.display = ev.loop ? '' : 'none';
        elRoundBadge.textContent   = '第 1 轮';
        elBatchBadge.style.display = ev.batchSize > 1 ? '' : 'none';
        elBatchBadge.textContent   = `×${ev.batchSize} 并发`;
        return;
      }

      if (phase === 'opening') {
        activeBatchSet = new Set(ev.batchOrigIndices);
        const batchLabel = ev.batchOrigIndices.length > 1
          ? `批次 ${Math.floor(ev.batchStart / ctrl._batchSize || 1) + 1}：第 ${ev.batchStart + 1}–${ev.batchEnd + 1} 篇（共${ev.batchOrigIndices.length}个）`
          : `正在打开第 ${ev.batchStart + 1} 篇`;
        elPLabel.textContent = batchLabel;
        elPUrl.textContent   = ev.batchLinks.length > 1 ? `同时打开 ${ev.batchLinks.length} 篇` : (ev.batchLinks[0] || '');
        elCntdwn.textContent = '…'; elRing.style.strokeDashoffset = 0;
        elCState.style.display = autoCollect ? '' : 'none';
        if (ev.round > 1) elRoundBadge.textContent = `第 ${ev.round} 轮`;
        renderList(ev.batchOrigIndices[0]); setProgress(ev.batchStart, ev.total);
      }

      if (phase === 'countdown') {
        const pct = 1 - (ev.remaining - 1) / ev.total;
        elCntdwn.textContent = ev.remaining;
        elRing.style.strokeDashoffset = (CIRC * pct).toFixed(2);
        elPLabel.textContent = `停留中… ${ev.remaining}s（批次 ${ev.batchStart + 1}–${ev.batchEnd + 1} / ${ev.totalLinks}）`;
      }

      if (phase === 'closed') {
        ev.batchOrigIndices.forEach(i => doneSet.add(i));
        activeBatchSet.clear();
        const nextScrollIdx = ev.batchEnd + 1 < articles.length ? ev.batchEnd + 1 : -1;
        renderList(nextScrollIdx); setProgress(ev.batchEnd + 1, ev.total);
      }

      if (phase === 'round_done') {
        doneSet.clear(); activeBatchSet.clear(); renderList(-1); setProgress(0, articles.length);
        setBadge(`第 ${ev.round} 轮完成`, 't-orange');
        elPLabel.textContent     = `第 ${ev.round} 轮完成，即将开始第 ${ev.round + 1} 轮…`;
        elRoundBadge.textContent = `第 ${ev.round + 1} 轮`;
        elRing.style.stroke = '#fa8c16'; elCntdwn.textContent = '↺';
      }

      if (phase === 'done') {
        setBadge('完成 ✓', 't-green');
        elStart.style.display = ''; elStart.disabled = false;
        elStop.style.display = 'none'; elFetch.disabled = false;
        elCntdwn.textContent = '✓'; elRing.style.stroke = '#52c41a';
        elPLabel.textContent = '全部访问完毕！'; activeBatchSet.clear();
        setProgress(articles.length, articles.length); renderList(-1);
      }

      if (phase === 'stopped') {
        setBadge('已停止', 't-orange');
        elStart.style.display = ''; elStart.disabled = false;
        elStop.style.display = 'none'; elFetch.disabled = false;
        elPLabel.textContent = '已手动停止'; activeBatchSet.clear(); renderList(-1);
      }
    }

    // ── 获取文章 ──
    elFetch.onclick = async () => {
      const rawUrl = elUrl.value.trim();
      if (!rawUrl) { elUrl.focus(); return; }
      const username = extractUsername(rawUrl);
      if (!username) { alert('无法识别用户名，示例：https://blog.csdn.net/用户名'); return; }

      elFetch.disabled = true; elFetch.textContent = '获取中…';
      elStart.disabled = true; setBadge('获取中…', 't-blue');
      elFProg.style.display = ''; elFPCur.textContent = '0'; elFPTotal.textContent = '?';
      selectedSet.clear(); doneSet.clear(); activeBatchSet.clear(); lastClickIdx = -1;
      showViewMode = false; updateSelCount(); elViewResult.style.display = 'none';
      elShowViews.textContent = '显示阅读量'; elShowViews.style.cssText = '';

      const limitVal = parseInt(elLimit.value, 10);
      const limit    = limitVal > 0 ? limitVal : 0;
      elList.innerHTML = `<div style="text-align:center;color:#1677ff;padding:14px 0;font-size:13px;">正在获取${limit ? '最近 '+limit+' 篇' : '全部'}文章…</div>`;

      try {
        const result  = await fetchAllArticles(username,
          (f, t) => { elFPCur.textContent = f; elFPTotal.textContent = t; },
          limit
        );
        articles    = result.links;
        articleMeta = result.metas;

        elCount.textContent   = `（共 ${articles.length} 篇）`;
        elFProg.style.display = 'none';
        elRangeTo.max = articles.length;
        elRangeTo.placeholder = String(articles.length);

        if (articles.length) {
          renderList(); elStart.disabled = false;
          setBadge(`${articles.length} 篇`, 't-blue');
          updateEfficiency();
        } else {
          elList.innerHTML = `<div style="text-align:center;color:#fa8c16;padding:14px 0;">未获取到文章</div>`;
          setBadge('无文章', 't-orange');
        }
      } catch (e) {
        elFProg.style.display = 'none';
        elList.innerHTML = `<div style="text-align:center;color:#ff4d4f;padding:14px 0;">${escHtml(e.message)}</div>`;
        setBadge('获取失败', 't-orange');
      } finally {
        elFetch.textContent = '获取文章'; elFetch.disabled = false;
      }
    };

    // ── 开始 ──
    elStart.onclick = () => {
      if (!articles.length) return;
      let visitLinks, visitOrigIndices;
      if (customMode && selectedSet.size > 0) {
        visitOrigIndices = [...selectedSet].sort((a, b) => a - b);
        visitLinks       = visitOrigIndices.map(i => articles[i]);
      } else {
        visitOrigIndices = articles.map((_, i) => i);
        visitLinks       = [...articles];
      }
      const sec  = Math.max(0.5, parseFloat(elSec.value) || 0.5);
      const bs   = Math.max(1, Math.min(20, parseInt(elBatch.value, 10) || 5));
      ctrl._batchSize = bs; // 供 handleUpdate 读取
      ctrl.start(visitLinks, visitOrigIndices, sec, autoCollect, loopMode, bs);
    };

    elStop.onclick  = () => ctrl.stop();
    elClose.onclick = () => { if (ctrl.running) ctrl.stop(); panel.remove(); };

    // ── 拖拽 ──
    let drag = false, ox = 0, oy = 0;
    $('#av2_titlebar', panel).addEventListener('mousedown', e => {
      if (e.target.id === 'av2_close') return;
      drag = true; ox = e.clientX - panel.offsetLeft; oy = e.clientY - panel.offsetTop;
    });
    document.addEventListener('mousemove', e => {
      if (!drag) return;
      panel.style.right = 'auto';
      panel.style.left  = (e.clientX - ox) + 'px';
      panel.style.top   = (e.clientY - oy) + 'px';
    });
    document.addEventListener('mouseup', () => { drag = false; });
  }

  // ── 悬浮按钮 ─────────────────────────────────────────────
  function mountFab() {
    if ($('#' + FAB_ID)) return;
    const fab = document.createElement('button');
    fab.id = FAB_ID;
    fab.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"
      style="margin-right:5px;vertical-align:-1px"><path d="M13 2L3 14h9l-1 8 10-12h-9z"/></svg>互访助手`;
    fab.style.cssText = [
      'position:fixed;z-index:2147483646;right:16px;bottom:20px',
      'padding:9px 15px;border-radius:999px',
      'border:1px solid #d0d0d0;background:#fff;color:#111',
      'font-size:13px;font-family:-apple-system,sans-serif',
      'cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.10);transition:.15s',
    ].join(';');
    fab.onmouseenter = () => { fab.style.background='#f0f7ff'; fab.style.borderColor='#1677ff'; };
    fab.onmouseleave = () => { fab.style.background='#fff';    fab.style.borderColor='#d0d0d0'; };
    fab.onclick = () => {
      const p = $('#' + PANEL_ID);
      if (p) p.style.display = p.style.display === 'none' ? 'flex' : 'none';
      else buildPanel();
    };
    document.body.appendChild(fab);
  }

  GM_registerMenuCommand('打开互访助手', buildPanel);
  mountFab();
  setTimeout(mountFab, 1500);
})();
