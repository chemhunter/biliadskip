// ==UserScript==
// @name         BiliFavComments（B站评论收藏&备份）
// @namespace    https://github.com/chemhunter/biliadskip/raw/main/js/BiliFavComments.user.js
// @description  B站评论收藏：动作栏星星收藏（公开蓝星/私人粉星）、评论区导航条入口按钮、本地管理面板（搜索/导出/删除）、图片本地缓存、云端同步（顺带上传用户资料快照，供发布页悬停名片）
// @version      0.26
// @author       chmehunter
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/opus/*
// @match        https://www.bilibili.com/bangumi/*
// @match        https://space.bilibili.com/*
// @match        https://t.bilibili.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @icon         https://i0.hdslb.com/bfs/emote/bf7e00ecab02171f8461ee8cf439c73db9797748.png
// @run-at       document-end
// ==/UserScript==

(function() {
	'use strict';

	function log(...args) {
		console.log('[BiliFavComments] ', ...args);
	}

	// ======================================================
	// ============= 云端同步与账号授权 ======================
	// ======================================================
	// 写入鉴权 = 用户 JWT：发布页用户登录后
	// 经弹窗把 Supabase 会话令牌交给本脚本（FAV_AUTH），服务端验签解 uid 后落库盖 user_id。
	// anon key 是公开常量（与发布页一致，仅用于续期接口鉴权），源码可开源。
	const SYNC_URL = 'https://akoaopeqigjwpcksqdyf.supabase.co/functions/v1/biliFavSync';

	// ---- 账号授权常量 ----
	const AUTH_PAGE_URL = 'https://vq8r8gj5.qwenwork.host/';
	const AUTH_PAGE_ORIGIN = 'https://vq8r8gj5.qwenwork.host';
	const SUPABASE_URL = 'https://akoaopeqigjwpcksqdyf.supabase.co';
	const SUPABASE_ANON_KEY = [
		'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
		'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFrb2FvcGVxaWdqd3Bja3NxZHlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQ0MDgwMzEsImV4cCI6MjA2OTk4NDAzMX0',
		'6JW6Gtescu5btG25b3en9w84ZbO40Z4fy3iUfWROIOM',
	].join('.');
	const FAV_AUTH_KEY = 'bili_fav_auth';
	const FAV_AUTH_RENEW_KEY = 'bili_fav_auth_last_renew';   // 上次成功续期（或刚拿到授权）的时刻，epoch 毫秒
	let favAuthCache = null;

	// 续期策略：**只在真要调云端、且 access_token 确实快过期时**才轮换（见 ensureFavAuthToken），
	// 不做定时器/固定周期续期。原因：脚本手里这枚 refresh_token 是发布页原样转交的，两边同属一族会话。
	// Supabase 默认开着 Refresh Token Rotation（一次性令牌），而托管版的 Reuse Interval 上限只有 300 秒，
	// 盖不住 access_token 约 1 小时的续期间隔；谁先轮换，另一边的旧令牌就作废，再拿旧的去做自动续期会被
	// 判为重用并吊销整族会话 —— 结果是发布页掉登录、脚本这份新令牌也一起死。所以轮换次数必须尽量少。

	// 授权读取/保存：GM 存储 {access_token, refresh_token, expires_at(ms)}
	async function getFavAuth() {
		if (favAuthCache) return favAuthCache;
		const raw = await GM_getValue(FAV_AUTH_KEY, null);
		favAuthCache = (raw && typeof raw === 'object' && raw.refresh_token) ? raw : null;
		return favAuthCache;
	}

	async function saveFavAuth(auth) {
		favAuthCache = auth || null;
		if (auth) await GM_setValue(FAV_AUTH_KEY, auth);
		else await GM_deleteValue(FAV_AUTH_KEY);
		notifyAuthChanged();
		return favAuthCache;
	}

	// 校验并保存一份授权数据（弹窗回传与手动导入令牌共用），格式非法返回 null
	async function applyAuthPayload(d) {
		if (!d || typeof d !== 'object' || !d.access_token || !d.refresh_token) return null;
		const auth = {
			access_token: String(d.access_token),
			refresh_token: String(d.refresh_token),
			expires_at: d.expires_at || (Date.now() + 3600 * 1000),
		};
		await saveFavAuth(auth);
		await GM_setValue(FAV_AUTH_RENEW_KEY, Date.now());   // 刚拿到的授权记为「上次续期」时刻，供状态栏显示
		return auth;
	}

	// 用 refresh_token 换一对新令牌。注意 Supabase 会轮换：旧 refresh_token 当场作废
	async function renewFavAuth() {
		const auth = await getFavAuth();
		if (!auth || !auth.refresh_token) return null;
		try {
			const r = await fetch(SUPABASE_URL + '/auth/v1/token?grant_type=refresh_token', {
				method: 'POST',
				headers: { apikey: SUPABASE_ANON_KEY, 'Content-Type': 'application/json' },
				body: JSON.stringify({ refresh_token: auth.refresh_token }),
			});
			const j = await r.json();
			if (r.ok && j.access_token && j.refresh_token) {
				await saveFavAuth({
					access_token: j.access_token,
					refresh_token: j.refresh_token,
					expires_at: Date.now() + (j.expires_in || 3600) * 1000,
				});
				await GM_setValue(FAV_AUTH_RENEW_KEY, Date.now());
				log('🔑 授权已自动续期，有效期至 ' + new Date(favAuthCache.expires_at).toLocaleString());
				return favAuthCache.access_token;
			}
			log('⚠️ 授权续期失败（可能已在发布页登出，或发布页刚用过同一枚 refresh_token），请重新授权:', j);
			await saveFavAuth(null);   // 失效令牌清掉，避免每次同步都白跑
		} catch (e) {
			log('🔑 授权续期请求失败:', e);   // 网络类失败不清令牌，下次接着试
		}
		return null;
	}

	// 取未过期的 access_token：过期前 60s 用 refresh_token 续期（Supabase 会轮换 refresh_token）
	async function ensureFavAuthToken() {
		// 按需续期：这是唯一的续期入口，只在真要调云端前被调用
		const auth = await getFavAuth();
		if (!auth) return null;
		if (auth.access_token && auth.expires_at && auth.expires_at - 60000 > Date.now()) return auth.access_token;
		return renewFavAuth();
	}

	// 接收发布页授权弹窗的 postMessage（来源必须为本域，令牌仅在用户主动点发送时发出）
	function installAuthMessageListener() {
		window.addEventListener('message', (e) => {
			if (e.origin !== AUTH_PAGE_ORIGIN) return;
			const d = e.data;
			if (!d || d.source !== 'bili-fav-auth' || !d.access_token || !d.refresh_token) return;
			applyAuthPayload(d).then(auth => {
				if (!auth) return;
				log('🔑 脚本授权成功');
				showFavToast('🔑 脚本授权成功，云端同步已启用');
			});
		});
	}

	// ---- 同步时间戳：上次「评论同步」跑完的时刻（epoch 毫秒），0 = 从未同步 ----
	// 只作为「本地哪些条目需要跟云端比对」的水位线：同步成功才推进，失败保持原值下次继续覆盖到
	const FAV_SYNC_TS_KEY = 'bili_fav_sync_ts';

	async function getFavSyncTs() {
		const v = await GM_getValue(FAV_SYNC_TS_KEY, 0);
		return Number(v) || 0;
	}

	async function setFavSyncTs(ts) {
		await GM_setValue(FAV_SYNC_TS_KEY, Number(ts) || 0);
		return Number(ts) || 0;
	}

	// ======================================================
	// ============= UI 辅助函数（样式统一管理）=============
	// ======================================================
	const COMMON_STYLES = {
		buttonBase: `padding: 4px 12px; border: 1px solid #ccc; background: #f0f0f0; border-radius: 4px; cursor: pointer; font-size: 13px;`,
		// 弹窗基础样式
		popupBase: `position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); padding: 20px; background: #fff; border: 1px solid #ccc; border-radius: 10px; z-index: 10000;
		    font-size: 16px; box-shadow: 0 4px 8px rgba(0,0,0,0.2); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;`,
		// 关闭按钮X
		closeX: `position: absolute; top: 5px; right: 12px; cursor: pointer; font-size: 20px; color: #999; line-height: 1; transition: color 0.2s, transform 0.2s; user-select: none; z-index: 10001;`,
		// 弹窗标题
		title: `text-align: center; margin-bottom: 16px; font-weight: bold; cursor: move; user-select: none;`,
	};

	function createElement(tag, props = {}, children = []) {
		const el = document.createElement(tag);
		if (props.style) {
			if (typeof props.style === 'object') {
				let css = '';
				for (const [k, v] of Object.entries(props.style)) {
					css += `${k.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}: ${v}; `;
				}
				el.style.cssText = css;
			} else {
				el.style.cssText = props.style;
			}
			delete props.style;
		}
		for (const [k, v] of Object.entries(props)) {
			if (k === 'className') el.className = v;
			else if (k === 'textContent') el.textContent = v;
			else if (k === 'innerHTML') el.innerHTML = v;
			else if (k.startsWith('on') && typeof v === 'function') el[k] = v;
			else el.setAttribute(k, v);
		}
		if (Array.isArray(children)) {
			children.forEach(child => {
				if (typeof child === 'string') el.appendChild(document.createTextNode(child));
				else if (child) el.appendChild(child);
			});
		}
		return el;
	}

	function createButton(text, onClick, extraStyle = '') {
		return createElement('button', {
			type: 'button',
			textContent: text,
			style: `${COMMON_STYLES.buttonBase} ${extraStyle}`,
			onclick: onClick
		});
	}

	function createPopupContainer(id, width = '720px') {
		const container = createElement('div', { id, style: `${COMMON_STYLES.popupBase} width: ${width};`});
		return container;
	}

	function addCloseX(container, onClose) {
		const x = createElement('div', {
			textContent: '❌',
			title: '关闭界面',
			style: COMMON_STYLES.closeX,
			onclick: () => { if (onClose) onClose(); }
		});
		x.onmouseover = () => { x.style.color = '#ff4d4f'; x.style.transform = 'scale(1.1)'; };
		x.onmouseout = () => { x.style.color = '#999'; x.style.transform = 'scale(1)'; };
		container.appendChild(x);
		return container;
	}

	const draggableManager = (() => {
		let targetElement = null;
		let isDragging = false;
		let offsetX, offsetY;

		document.addEventListener('mousemove', (e) => {
			if (isDragging && targetElement) {
				const newLeft = e.clientX - offsetX;
				const newTop = e.clientY - offsetY;
				targetElement.style.left = `${newLeft}px`;
				targetElement.style.top = `${newTop}px`;
			}
		});

		document.addEventListener('mouseup', () => {
			isDragging = false;
			targetElement = null;
		});

		return {
			makeDraggable: function(container, handle) {
				handle.addEventListener('mousedown', (e) => {
					isDragging = true;
					targetElement = container;
					offsetX = e.clientX - container.offsetLeft;
					offsetY = e.clientY - container.offsetTop;
					handle.style.cursor = 'move';
					document.body.style.userSelect = 'none';
					e.preventDefault();
				});
				handle.addEventListener('mouseup', () => {
					document.body.style.userSelect = '';
				});
			}
		};
	})();

	// 深度查询选择器（支持多层 shadow-root）
	// 注意：自定义组件（如 bili-comment-box / bili-comment-renderer）把内容渲染在**宿主元素自己的
	// shadowRoot** 里，传元素时必须连它自身的影子树一起扫，否则什么都找不到。
	function querySelectorAllDeep(root, selector) {
		const results = [];
		if (!root) return results;
		const scan = (scope) => {
			try { results.push(...scope.querySelectorAll(selector)); } catch (e) { /* 选择器非法等，忽略 */ }
			for (const el of scope.querySelectorAll('*')) {
				if (el.shadowRoot) scan(el.shadowRoot);
			}
		};
		if (root.nodeType === 1 && root.shadowRoot) scan(root.shadowRoot);
		scan(root);
		return results;
	}

	// ======================================================
	// ============= 评论收藏模块 ===========================
	// ======================================================
	const FAV_KEY = 'bili_favorites';

	// 已收藏 rpid 集合缓存（null 表示尚未加载），供注入时同步预标灰
	let favSetCache = null;
	// rpid → 是否私人收藏（与 favSetCache 同时建）；决定星标是蓝还是粉
	let favPrivCache = null;

	// 新收藏的默认可见性：公开（默认）/ 私人。
	// 私人 = 这条收藏（连同它名下的回复）只在发布页「你自己的视图」里出现，其他访客读不到。
	const FAV_PRIV_DEFAULT_KEY = 'bili_fav_default_private';

	async function getFavDefaultPrivate() {
		try { return (await GM_getValue(FAV_PRIV_DEFAULT_KEY, false)) === true; }
		catch (e) { return false; }
	}

	async function setFavDefaultPrivate(v) {
		const flag = v === true;
		try { await GM_setValue(FAV_PRIV_DEFAULT_KEY, flag); }
		catch (e) { log('⚠️ 默认可见性保存失败:', e); }
		return flag;
	}

	// 读取时规范化：清掉顶层的空 parent/root/children 与子评论的冗余字段（旧数据也生效）
	function sanitizeChild(c) {
		if (!c || !c.rpid_str) return null;
		const out = Object.assign({}, c);
		delete out.videoTitle;
		delete out.upName;
		delete out.children;
		return out;
	}

	function sanitizeTop(e) {
		if (!e || !e.rpid_str) return null;
		const out = Object.assign({}, e);
		if (!out.parent) delete out.parent;
		if (!out.root) delete out.root;
		if (Array.isArray(out.children)) {
			out.children = out.children.map(sanitizeChild).filter(Boolean);
			if (!out.children.length) delete out.children;
		} else {
			delete out.children;
		}
		return out;
	}

	async function getFavorites() {
		const list = await GM_getValue(FAV_KEY, null);
		return Array.isArray(list) ? list.map(sanitizeTop).filter(Boolean) : [];
	}

	async function loadFavCache() {
		const list = await getFavorites();
		const s = new Set();
		const priv = new Map();
		for (const top of list) {
			const p = top && top.isPrivate === true;
			if (top && top.rpid_str) { s.add(top.rpid_str); priv.set(top.rpid_str, p); }
			if (top && Array.isArray(top.children)) {
				// 隐私以「主评论那一组」为单位，子评论跟着父组走
				for (const c of top.children) if (c && c.rpid_str) { s.add(c.rpid_str); priv.set(c.rpid_str, p); }
			}
		}
		favSetCache = s;
		favPrivCache = priv;
		return favSetCache;
	}

	// 把动作栏的星星按钮标成已收藏态（只改填充色，不能动 textContent）
	// 公开=蓝实心，私人=粉实心（与发布页的私人标识同一色系）
	function markFaved(btn, priv) {
		if (!btn) return;
		paintFavBtn(btn, true, priv);
	}

	// 恢复为未收藏态（取消收藏时用）
	function unmarkFaved(btn) {
		if (!btn) return;
		paintFavBtn(btn, false);
	}

	// 以 rpid_str 为主键去重保存，返回 true 表示新增、false 表示更新
	// 顶层 upsert（保留已存在的子评论），返回 {isNew, ref}；空 children 不落库
	function upsertTopEntry(list, entry) {
		const i = list.findIndex(x => x && x.rpid_str === entry.rpid_str);
		if (i >= 0) {
			const old = list[i];
			const merged = Object.assign({}, entry, { savedAt: old.savedAt || entry.savedAt });
			// 隐私设置只在「显式给了值」时才覆盖：收藏某条子回复会顺带 upsert 父组，
			// 不带这个保护就会把父组原有的私人设置悄悄刷回公开
			if (entry.isPrivate === undefined && old.isPrivate !== undefined) merged.isPrivate = old.isPrivate;
			if (Array.isArray(old.children) && old.children.length) merged.children = old.children;
			else delete merged.children;
			list[i] = merged;
			return { isNew: false, ref: merged };
		}
		list.unshift(entry);
		return { isNew: true, ref: entry };
	}

	// 在某父条目下 upsert 子评论，返回是否新增
	function upsertChildEntry(parent, child) {
		if (!Array.isArray(parent.children)) parent.children = [];
		const i = parent.children.findIndex(c => c && c.rpid_str === child.rpid_str);
		if (i >= 0) {
			parent.children[i] = Object.assign({}, child);
			return false;
		}
		parent.children.push(child);
		return true;
	}

	// 跨 shadow 边界向上爬到指定标签的宿主元素
	function climbToTag(el, tag) {
		while (el) {
			if (el.tagName === tag) return el;
			el = el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
		}
		return null;
	}

	// ---------- 页面初始状态读取（比 DOM 类名稳定，B站改版不易受影响） ----------
	// Tampermonkey 带 @grant 时脚本跑在隔离世界，页面自己的全局量（__INITIAL_STATE__）
	// 必须经 unsafeWindow 才能读到；不支持该 API 的环境自动退回 window。
	function pageWin() {
		try {
		if (typeof unsafeWindow !== 'undefined' && unsafeWindow) return unsafeWindow;
		} catch (e) { /* ignore */ }
		return window;
	}

	function initialState() {
		try { return pageWin().__INITIAL_STATE__ || null; } catch (e) { return null; }
	}

	function fmtPubdate(sec) {
		if (!sec) return '';
		const d = new Date(sec * 1000);
		const pad = n => String(n).padStart(2, '0');
		return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	}

	// 从 __INITIAL_STATE__ 取视频/番剧元信息；取不到返回 null 交给 DOM 兜底
	function getMetaFromState() {
		const st = initialState();
		if (!st) return null;
		const vd = st.videoData;
		if (vd && (vd.title || vd.bvid)) {
			return {
				kind: 'video',
				title: vd.title || '',
				upName: (vd.owner && vd.owner.name) || (st.upData && st.upData.name) || '',
				upMid: (vd.owner && vd.owner.mid) || (st.upData && st.upData.mid) || null,
				bvid: vd.bvid || st.bvid || '',
				aid: vd.aid || st.aid || '',
				publishTime: fmtPubdate(vd.pubdate),
				duration: vd.duration || 0,
				category: vd.tname || '',
				// 多人投稿：staff 含 UP主/文案/配音 等角色，主投稿人仍是 owner
				staff: Array.isArray(vd.staff)
				? vd.staff.map(s => ({ mid: s.mid, name: s.name, title: s.title || '' })).filter(s => s.name)
				: [],
			};
		}
		// 番剧页字段名不同，能取多少取多少，缺的由 DOM 补
		const mi = st.mediaInfo;
		if (mi && (mi.title || mi.english_title)) {
			return {
				kind: 'bangumi',
				title: mi.title || mi.english_title || '',
				upName: (mi.up_info && (mi.up_info.name || mi.up_info.follower)) || '',
				upMid: (mi.up_info && mi.up_info.fid) || mi.up_id || null,
				bvid: '', aid: '',
				publishTime: '', duration: 0, category: '',
				staff: [],
			};
		}
		return null;
	}

	// 取官方分享链接（与原生"复制评论链接"同一接口），失败则回退拼锚点链接
	async function getReplyShareUrl(oid, type, rpid) {
		try {
			const resp = await fetch(
				`https://api.bilibili.com/x/v2/reply/share_reply_material?oid=${encodeURIComponent(oid)}&type=${encodeURIComponent(type)}&rpid=${encodeURIComponent(rpid)}`,
				{ credentials: 'include' }
			);
			const j = await resp.json();
			if (j && j.code === 0 && j.data && j.data.reply_share_url) return j.data.reply_share_url;
		} catch (e) {
			log('获取分享链接失败，使用拼接链接兜底:', e);
		}
		// 兜底优先用 BV 号（可读性更好且与站内规范一致），拿不到再退回 av+oid
		const sm = getMetaFromState();
		const base = (sm && sm.bvid) ? `https://www.bilibili.com/video/${sm.bvid}` : `https://www.bilibili.com/video/av${oid}`;
		return `${base}/#reply${rpid}`;
	}

	// 轻量 toast
	function showFavToast(msg) {
		const t = document.createElement('div');
		t.textContent = msg;
		t.style.cssText = 'position:fixed;top:70px;left:50%;transform:translateX(-50%);z-index:2147483647;background:rgba(0,0,0,.82);color:#fff;padding:8px 18px;border-radius:20px;font-size:14px;transition:opacity .3s;';
		document.body.appendChild(t);
		setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 1600);
	}

	// 获取视频/动态信息 - 结构化模式识别版
	function getVideoInfo(contextFooter = null) {
		const isDyn = isDynamicPage();
		if (!isDyn) {
			// 视频页：优先读 __INITIAL_STATE__，DOM 仅作兜底
			const sm = getMetaFromState();
			const titleEl = document.querySelector('.video-info-title h1.video-title, h1.video-title, .video-title');
			return {
				type: sm ? sm.kind : 'video',
				videoTitle: (sm && sm.title) || (titleEl ? titleEl.textContent.trim() : ''),
				upName: (sm && sm.upName) || document.querySelector('.up-name')?.textContent.trim() || '',
				upMid: (sm && sm.upMid) || domUpMid(),
				bvid: (sm && sm.bvid) || '',
				publishTime: (sm && sm.publishTime) || document.querySelector('.pubdate-ip-text')?.textContent.trim() || '',
			staff: (sm && sm.staff) || [],
			};
		}

		// ==================== 动态页 ====================
		let scope = document;
		let replyText = null;
		let isReplyMode = false;
		let dynItem = null;

		if (contextFooter) {
			let current = contextFooter;
			while (current && !dynItem) {
				if (current.nodeType === Node.DOCUMENT_FRAGMENT_NODE && current.host) current = current.host;
				if (!isReplyMode && (current.id === 'reply-container' || current.classList?.contains('reply-container'))) {
					isReplyMode = true;
					const cr = current.parentElement?.querySelector('bili-comment-renderer[id="comment"]') ||
						  current.closest('bili-comment-thread-renderer')?.querySelector('bili-comment-renderer[id="comment"]');
					if (cr) {
						const el = cr.shadowRoot?.querySelector('#content, .bili-rich-text') || cr.querySelector('#content, .bili-rich-text');
						replyText = el ? (el.innerText || el.textContent || '').trim() : '';
					}
				}
				if (current.classList?.contains('bili-dyn-item')) {
					dynItem = current;
					break;
				}
				current = current.parentElement || (current.getRootNode?.() !== document ? current.getRootNode().host : null);
			}
			if (dynItem) {
				scope = dynItem.querySelector('.bili-dyn-item__body, .bili-dyn-content') || dynItem;
			}
		}

		// ==================== 模式识别 + 结构化提取 ====================
		const result = {
			type: 'dny',
			originalText: '', // 转发时的原创文字
			videoTitle: '',
			upName: '', // 动态博主ID
			upMid: '', // 动态博主 mid（DOM 无链接，只能从组件数据里读）
			replyText: replyText,
			isReplyMode: isReplyMode
		};

		// 0. 提取博主ID（从header中提取）
		const upNameEl = dynItem?.querySelector('.bili-dyn-title__text') || scope.querySelector('.bili-dyn-title__text');
		if (upNameEl) {
			result.upName = (upNameEl.innerText || upNameEl.textContent || '').trim();
		}
		// 0b. 博主 mid：新版动态卡片里作者名是 span、没有 space 链接，DOM 拿不到 ID，
		//     读组件实例的 module_author；昵称缺失时用组件里的 name 校正（DOM 文本可能带会员后缀/空白）
		const dynAuthor = dynAuthorMid(dynItem);
		if (dynAuthor) {
			result.upMid = dynAuthor.mid;
			if (!result.upName && dynAuthor.name) result.upName = dynAuthor.name;
		}

		// 1. 提取原创文字（转发动态最上层文字）
		const origDescEl = scope.querySelector('.bili-dyn-content__orig__desc .bili-rich-text__content') || scope.querySelector('.bili-dyn-content__forw__desc .bili-rich-text__content');
		if (origDescEl) {
			result.originalText = (origDescEl.innerText || origDescEl.textContent || '').replace(/\s+/g, ' ').trim();
		}

		// 2. Opus 类型（长文本动态）
		const opusEl = scope.querySelector('.dyn-card-opus__summary .opus-paragraph-children p');
		if (opusEl) {
			result.type = 'opus';
			result.videoTitle = (opusEl.innerText || opusEl.textContent || '').replace(/\s+/g, ' ').trim();
		}

		// 3. 视频卡片（最常见于转发动态）
		const videoCard = scope.querySelector('.bili-dyn-card-video');
		if (videoCard) {
			result.type = 'repost_video';
			const vTitle = videoCard.querySelector('.bili-dyn-card-video__title');
			result.videoTitle = vTitle ? vTitle.textContent.trim() : '';
		}

		// 4. 纯文本动态（无视频卡片）
		if (!result.videoTitle && !videoCard) {
			const richText = scope.querySelector('.bili-rich-text__content');
			if (richText) {
				result.type = 'text';
				result.videoTitle = (richText.innerText || richText.textContent || '').replace(/\s+/g, ' ').trim();
			}
		}

		return result;
	}

	// 取当前页视频/动态的标题与UP主昵称（getVideoInfo 已含 upName）
	function getPageMeta(contextEl) {
		let title = '', upName = '', upMid = '';
		// 视频/番剧页：状态里字段齐全，直接取；动态页无此结构，落到 getVideoInfo 的模式识别
		const sm = getMetaFromState();
		if (sm) {
			title = sm.title || '';
			upName = sm.upName || '';
			upMid = sm.upMid ? String(sm.upMid) : '';
		}
		if (!title || !upName || !upMid) {
			try {
				const info = getVideoInfo(contextEl || null) || {};
				title = title || info.videoTitle || '';
				upName = upName || info.upName || '';
				upMid = upMid || (info.upMid ? String(info.upMid) : '');
			} catch (e) { /* ignore */ }
		}
		if (!title) title = (document.title || '').replace(/[_-].*?(哔哩哔哩|bilibili).*$/i, '').trim();
		return { title, upName, upMid };
	}

	// 图片URL去掉 @处理后缀/查询串，取文件名（hash.jpg），用于跨 i0/i1/i2 子域匹配
	function picFilename(url) {
		let b = (url || '').split('@')[0].split(/[?#]/)[0];
		const parts = b.split('/');
		return parts[parts.length - 1] || b;
	}

	// 收集评论渲染出的 <img> 真实 src（含 B 站的 @尺寸.avif 缩略图后缀），按文件名建表
	function buildThumbMap(hostEl) {
		const map = {};
		if (!hostEl) return map;
		const roots = [hostEl, hostEl.shadowRoot].filter(Boolean);
		for (const r of roots) {
			for (const im of querySelectorAllDeep(r, 'img')) {
				const s = im.currentSrc || im.src || '';
				if (s) map[picFilename(s)] = s;
			}
		}
		return map;
	}

	// ---------- IndexedDB 图片本地缓存（键=图片URL，存 Blob） ----------
	const FAV_DB_NAME = 'bili_fav_media';
	const FAV_DB_STORE = 'images';
	let favDbPromise = null;
	let favObjectUrls = [];

	function revokeFavObjectUrls() {
		for (const u of favObjectUrls) { try { URL.revokeObjectURL(u); } catch (e) { /* ignore */ } }
		favObjectUrls = [];
	}

	function openFavDb() {
		if (favDbPromise) return favDbPromise;
		favDbPromise = new Promise((resolve, reject) => {
			const req = indexedDB.open(FAV_DB_NAME, 1);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(FAV_DB_STORE)) db.createObjectStore(FAV_DB_STORE);
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
		return favDbPromise;
	}

	function idbPut(key, blob) {
		return openFavDb().then(db => new Promise((res, rej) => {
			const tx = db.transaction(FAV_DB_STORE, 'readwrite');
			tx.objectStore(FAV_DB_STORE).put(blob, key);
			tx.oncomplete = () => res();
			tx.onerror = () => rej(tx.error);
		}));
	}

	function idbGet(key) {
		return openFavDb().then(db => new Promise((res) => {
			const r = db.transaction(FAV_DB_STORE, 'readonly').objectStore(FAV_DB_STORE).get(key);
			r.onsuccess = () => res(r.result || null);
			r.onerror = () => res(null);
		}));
	}

	// B站图床裸原图常是 http://，https 页面 fetch 会被混合内容拦截，统一升级到 https
	function toHttps(u) { return (u || '').replace(/^http:\/\//i, 'https://'); }

	async function fetchBlob(url) {
		const resp = await fetch(toHttps(url), { credentials: 'omit' });
		if (!resp.ok) throw new Error('HTTP ' + resp.status);
		return await resp.blob();
	}

	// 下载并缓存某条收藏的所有图片（原图+缩略图），已缓存的跳过；返回新增数量
	async function cacheFavoriteImages(entry) {
		const pics = Array.isArray(entry && entry.pictures) ? entry.pictures : [];
		let added = 0;
		for (const pic of pics) {
			const orig = typeof pic === 'string' ? pic : (pic && pic.orig);
			const thumb = typeof pic === 'string' ? pic : (pic && pic.thumb);
			for (const u of [thumb, orig]) {
				if (!u) continue;
				try {
					if (await idbGet(u)) continue;
					const blob = await fetchBlob(u);
					await idbPut(u, blob);
					added++;
				} catch (e) { log('图片缓存失败:', u, e); }
			}
		}
		return added;
	}

	// 给所有收藏补缓存图片（旧收藏/失败项），完成后刷新面板
	async function cacheAllImages() {
		const list = await getFavorites();
		if (!list.length) { showFavToast('没有收藏'); return; }
		showFavToast('🖼 开始缓存图片…');
		let n = 0;
		for (const entry of list) {
			n += await cacheFavoriteImages(entry);
		}
		await refreshFavPanel();
		showFavToast(`🖼 缓存完成，新增 ${n} 张`);
	}

	// 从 UP 卡片链接取 mid：兼容单UP(a.up-name)与多人投稿(a.staff-name)；
	// 这两个选择器只在 UP 信息区内，不会误取导航栏里当前登录用户自己的头像链接
	function domUpMid() {
		const sels = ['a.staff-name', 'a.up-name', '.up-info-container a[href*="space.bilibili.com/"]'];
		for (const sel of sels) {
			const a = document.querySelector(sel);
			const m = a && (a.getAttribute('href') || '').match(/space\.bilibili\.com\/(\d+)/);
			if (m) return m[1];
		}
		return null;
	}

	// 动态页取发布者 mid：新版动态卡片的作者名是 <span>、不带 space 链接，DOM 上根本取不到 ID，
	// 只能读组件实例里的原始数据。.bili-dyn-item 是 Vue2 组件，_props.data 就是接口返回的那条动态，
	// modules.module_author 即发布者（转发动态再退一步取 orig 的原作者）。
	// 只认传进来的那一个 dynItem —— 动态流里同时挂着几十条，绝不能拿首条的作者张冠李戴。
	function dynAuthorMid(dynItem) {
		if (!dynItem || !dynItem.classList || !dynItem.classList.contains('bili-dyn-item')) return null;
		try {
			const d = dynItem.__vue__ && dynItem.__vue__._props && dynItem.__vue__._props.data;
			const ma = (d && d.modules && d.modules.module_author) ||
				(d && d.orig && d.orig.modules && d.orig.modules.module_author);
			if (ma && ma.mid) return { mid: String(ma.mid), name: String(ma.name || '') };
		} catch (e) { /* 组件结构变了就当作取不到，交给后续兜底 */ }
		return null;
	}

	// 取 UP 主 mid：优先 __INITIAL_STATE__，其次 UP 卡片链接，最后动态页容器内爬
	function getUpMid(contextEl) {
		const sm = getMetaFromState();
		if (sm && sm.upMid) return String(sm.upMid);
		const dm = domUpMid();
		if (dm) return dm;
		try {
			let el = contextEl;
			while (el) {
				if (el.classList && el.classList.contains('bili-dyn-item')) {
					const author = dynAuthorMid(el);
					if (author) return author.mid;
					const a = el.querySelector('a[href*="space.bilibili.com/"]');
					const mm = a && (a.getAttribute('href') || '').match(/space\.bilibili\.com\/(\d+)/);
					if (mm) return mm[1];
					break;
				}
				el = el.parentElement || (el.getRootNode && el.getRootNode().host) || null;
			}
		} catch (e) { /* ignore */ }
		return null;
	}

	// 从评论渲染节点构建一条收藏条目（子评论存 parent/root，视频标题/UP主只在顶层存）
	async function buildEntry(renderer, isChild) {
		const data = renderer && renderer.data;
		if (!data || !data.rpid_str) return null;
		const oid = data.oid_str || (data.oid != null ? String(data.oid) : '');
		const type = data.type;
		const rpid = data.rpid_str;
		const url = await getReplyShareUrl(oid, type, rpid);
		const contentObj = data.content || {};
		// 抓 B 站已渲染的缩略图真实尺寸 URL；原图另存供点开大图
		const commentRenderer = climbToTag(renderer, 'BILI-COMMENT-RENDERER') || renderer;
		const thumbMap = buildThumbMap(commentRenderer);
		const pictures = (Array.isArray(contentObj.pictures) ? contentObj.pictures : [])
			.map(p => {
				const orig = toHttps((p && (p.img_src || p.img_url)) || '');
				if (!orig) return null;
				return { orig: orig, thumb: toHttps(thumbMap[picFilename(orig)] || orig) };
			})
			.filter(Boolean);
		// 昵称可能被注入成 "原始昵称 <归属地>"，拆成两个字段
		const rawName = (data.member && data.member.uname) || '';
		const nameMatch = rawName.match(/^(.*?)\s*<\s*([^<>]+?)\s*>\s*$/);
		const uname = nameMatch ? nameMatch[1].trim() : rawName;
		const location = nameMatch ? nameMatch[2].trim() : '';
		const meta = getPageMeta(renderer);
		const entry = {
			rpid_str: rpid,
			oid_str: oid,
			type: type,
			mid: data.member ? data.member.mid : null,
			uname: uname,
			location: location,
			content: contentObj.message || '',
			pictures: pictures,
			url: url,
			ctime: data.ctime || 0,
			savedAt: Date.now()
		};
		if (isChild) {
			// 子评论与主评论同页，视频标题/UP主从父级取，不冗余存储
			if (data.parent) entry.parent = String(data.parent);
			if (data.root) entry.root = String(data.root);
		} else {
			entry.videoTitle = meta.title;
			entry.upName = meta.upName;
			const upMid = meta.upMid || getUpMid(renderer);
			if (upMid) entry.upMid = String(upMid);
			if (data.parent && String(data.parent) !== '0') entry.parent = String(data.parent);
			if (data.root && String(data.root) !== '0') entry.root = String(data.root);
		}
		return entry;
	}

	// 子评论 → 其所在 thread 的最上层主评论渲染节点（#comment）
	function findMainCommentRenderer(subRenderer) {
		const thread = climbToTag(subRenderer, 'BILI-COMMENT-THREAD-RENDERER');
		if (!thread || !thread.shadowRoot) return null;
		return thread.shadowRoot.querySelector('#comment') || null;
	}

	// 面板刷新去抖：后台缓存批量完成时合并成一次全量重渲染
	let favRefreshTimer = null;
	function scheduleFavRefresh() {
		clearTimeout(favRefreshTimer);
		favRefreshTimer = setTimeout(() => { favRefreshTimer = null; refreshFavPanel(); }, 500);
	}

	function cacheImagesForEntry(entry) {
		if (entry && Array.isArray(entry.pictures) && entry.pictures.length) {
			cacheFavoriteImages(entry)
				.then(n => { if (n) { log(`已缓存 ${n} 张图片`); scheduleFavRefresh(); } })
				.catch(e => log('缓存图片出错', e));
		}
	}

	// 云端同步：把本次收藏条目发给 Edge Function（落库 + 原图转存 Storage），失败不影响本地
	// 同步地址内置（SYNC_URL）；鉴权：Authorization 带用户 JWT（过期自动续期），未授权静默跳过
	async function syncFavoriteToCloud(topEntry, childEntry) {
		if (!topEntry) return;
		const token = await ensureFavAuthToken();
		if (!token) { log('🔑 未授权或授权已失效，跳过云端同步（云端设置里走途径 A 授权或途径 B 导入令牌）'); return; }
		const payload = { top: topEntry };
		if (childEntry) payload.child = childEntry;
		// 顺手把这条评论涉及的人（作者 / UP 主 / 子评论作者）的资料一并带上，
		// 新收藏立刻就能在发布页悬停出名片，不用等到下次点「评论同步」
		try {
			const uc = await ensureUserCards(collectUserMids([topEntry, childEntry]));
			if (uc.fresh.length) payload.users = uc.fresh;
		} catch (e) { log('⚠️ 用户资料抓取失败（不影响评论同步）:', e); }
		fetch(SYNC_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
			body: JSON.stringify(payload),
		}).then(r => r.json()).then(j => {
			if (j && j.success) log('☁️ 云端同步完成:', j.results, '用户资料:', j.users);
			else if (j && j.error === 'unauthorized') log('⚠️ 云端同步被拒（登录已过期？重新授权试试）:', j);
			else log('⚠️ 云端同步返回异常:', j);
		}).catch(e => log('⚠️ 云端同步失败（离线或函数未部署）:', e));
	}

	const cloudHeaders = (token) => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + token });

	// ======================================================
	// ============ 用户资料快照（发布页名片数据源）==========
	// ======================================================
	// 发布页要显示「头像/等级/粉丝/关注/获赞/简介」的悬停名片，但 api.bilibili.com/x/web-interface/card
	// 的 CORS 只放行 *.bilibili.com —— 外站页面直取无解，只能由跑在同源里的本脚本顺手抓了上传。
	// 抓到的快照存两个地方：本地 GM 缓存（省请求）+ 云端 user_data 表（页面读它渲染）。
	// 快照本身是静态的：粉丝数不会自己动。靠 TTL 到期后重抓 + 用户持续收藏同一 UP 主的其它评论来缓慢刷新。
	const USERS_KEY = 'bili_fav_users';
	const USER_TTL = 7 * 24 * 3600 * 1000;   // 同一用户 7 天内不重抓
	const USER_FETCH_CAP = 150;              // 单轮最多抓多少人（首次补存量时分会分几轮）
	const USER_POST_SIZE = 50;               // 上传分块
	const USER_CARD_API = 'https://api.bilibili.com/x/web-interface/card';

	let usersCache = null;   // { [mid]: card }，首次用到时从 GM 存储载入

	async function loadUsersCache() {
		if (usersCache) return usersCache;
		let raw = null;
		try { raw = await GM_getValue(USERS_KEY, null); } catch (e) { raw = null; }
		usersCache = (raw && typeof raw === 'object') ? raw : {};
		return usersCache;
	}

	async function saveUsersCache() {
		try { await GM_setValue(USERS_KEY, usersCache || {}); }
		catch (e) { log('⚠️ 用户资料缓存写入失败:', e); }
	}

	// 抓一个人的 card 并归一成 user_data 行。任何异常都返回 null —— 半成品绝不往上传
	async function fetchUserCard(mid) {
		try {
			const r = await fetch(USER_CARD_API + '?mid=' + encodeURIComponent(mid) + '&photo=false', {
				credentials: 'include',   // 同源带 cookie，不带的话容易被风控 -352
			});
			const j = await r.json().catch(() => null);
			if (!r.ok || !j || j.code !== 0) {
				if (j && (j.code === -404 || j.code === 625)) log(`🙅 用户 ${mid} 不存在或已注销`);
				else log(`⚠️ 用户 ${mid} 资料接口异常:`, j && j.code, j && j.message);
				return null;
			}
			const c = j.data && j.data.card;
			if (!c || !c.mid || !c.name) return null;
			return {
				mid: String(c.mid),
				name: String(c.name),
				face: String(c.face || '').replace(/^http:\/\//i, 'https://'),
				sign: String(c.sign || ''),
				level: Number(c.level_info && c.level_info.current_level) || 0,
				fans: Number(j.data.follower != null ? j.data.follower : c.fans) || 0,
				following: Number(c.attention) || 0,
				likes: Number(j.data.like_num) || 0,
				fetched_at: Date.now(),
			};
		} catch (e) { log(`⚠️ 抓取用户 ${mid} 资料失败:`, e); return null; }
	}

	// 从条目里收集要抓的 mid：评论作者 + UP 主 + 各子评论作者
	function collectUserMids(items) {
		const set = new Set();
		const add = (v) => { const s = v == null ? '' : String(v); if (/^\d+$/.test(s) && s !== '0') set.add(s); };
		for (const it of (items || [])) {
			if (!it) continue;
			add(it.mid); add(it.upMid); add(it.up_mid);
			for (const c of (Array.isArray(it.children) ? it.children : [])) add(c && c.mid);
		}
		return Array.from(set);
	}

	// 保证这批 mid 都有资料：缓存缺失或已过期的现抓（4 路小并发，别把自己刷进风控）。
	// 只回「本轮新抓到的」—— 缓存里本来就有的没必要再传一趟，云端按 fetched_at 单调合并。
	async function ensureUserCards(mids) {
		const cache = await loadUsersCache();
		const now = Date.now();
		const stale = [];
		for (const mid of mids) {
			const hit = cache[mid];
			if (hit && hit.fetched_at && (now - hit.fetched_at) < USER_TTL) continue;
			stale.push(mid);
		}
		const need = stale.slice(0, USER_FETCH_CAP);
		const deferred = stale.length - need.length;
		if (!need.length) return { fresh: [], failed: 0, deferred: 0 };

		const fresh = [];
		let cursor = 0, failed = 0;
		const worker = async () => {
			while (cursor < need.length) {
				const mid = need[cursor++];
				const card = await fetchUserCard(mid);
				if (card) { cache[mid] = card; fresh.push(card); } else failed++;
			}
		};
		await Promise.all([worker(), worker(), worker(), worker()]);
		await saveUsersCache();
		log(`👤 用户资料：本轮抓取 ${fresh.length}/${need.length} 人` + (failed ? `，失败 ${failed}` : '') + (deferred ? `，还有 ${deferred} 人下轮继续` : ''));
		return { fresh, failed, deferred };
	}

	// 分块上传用户快照（biliFavSync 的第三种请求形态：只带 users，不动评论）
	async function postUserCards(cards, token, post) {
		let sent = 0;
		for (let i = 0; i < cards.length; i += USER_POST_SIZE) {
			const chunk = cards.slice(i, i + USER_POST_SIZE);
			try { await post({ users: chunk }); sent += chunk.length; }
			catch (e) { log('⚠️ 用户资料上传失败:', e); }
		}
		return sent;
	}

	// 单向「评论同步」：先问云端「上次同步之后」已有哪些 rpid（只认自己账号，服务端验签），
	// 再把本地有、云端没有的条目补传上去；不会从云端往本地拉，也不会删云端数据。
	// 全部成功才把时间戳推进到本轮开始时刻（过程中新收藏的留给下一轮），有失败则保持原值，下次再点即续传。
	async function runFavCloudSync(onProgress) {
		const token = await ensureFavAuthToken();
		if (!token) throw new Error('尚未授权或授权已失效：请先走途径 A / 途径 B 完成授权');
		const since = await getFavSyncTs();
		const startedAt = Date.now();
		const prog = (msg) => { if (onProgress) onProgress(msg); };
		const post = async (body) => {
			const r = await fetch(SYNC_URL, { method: 'POST', headers: cloudHeaders(token), body: JSON.stringify(body) });
			const j = await r.json().catch(() => null);
			if (!r.ok || !j || !j.success) throw new Error((j && (j.error || j.details)) || ('HTTP ' + r.status));
			return j;
		};

		prog('正在向云端索取已同步清单…');
		const lr = await fetch(SYNC_URL, {
			method: 'POST', headers: cloudHeaders(token),
			body: JSON.stringify({ action: 'list', since: since }),
		});
		const lj = await lr.json().catch(() => null);
		if (lr.status === 401) throw new Error('登录态被云端拒绝（401）：请在发布页重新授权');
		if (lj && lj.error === '缺少条目') throw new Error('云端函数版本过旧（不认识 action:"list"）：请重新部署 biliFavSync');
		if (!lj || !lj.success) throw new Error('索取清单失败：' + (lj ? JSON.stringify(lj).slice(0, 200) : 'HTTP ' + lr.status));

		// 用户资料：按「全部本地收藏」涉及的 mid 补齐，而不只是本轮要补传的那几条 ——
		// 存量收藏的作者往往还没进过 user_data，这样点一次同步就能把欠账还上（超过单轮上限的留到下轮）。
		const allEntries = await getFavorites();
		prog('正在补齐用户资料…');
		const uc = await ensureUserCards(collectUserMids(allEntries));
		let usersSent = 0;
		if (uc.fresh.length) {
			usersSent = await postUserCards(uc.fresh, token, post);
			prog(`用户资料已上传 ${usersSent} 人${uc.deferred ? `，还有 ${uc.deferred} 人待补（再点一次同步继续）` : ''}`);
		}

		const cloudTops = new Set((lj.tops || []).map(String));
		const cloudKids = new Set((lj.children || []).map(String));
		// 水位线判断：since=0（从未同步）时全量参与比对，缺 savedAt 的老数据也不漏
		const afterTs = (ts) => since <= 0 || Number(ts) > since;
		const list = allEntries;
		const missTops = [], missKids = [];
		for (const top of list) {
			if (!top || !top.rpid_str) continue;
			const topRpid = String(top.rpid_str);
			if (afterTs(top.savedAt) && !cloudTops.has(topRpid)) {
				cloudTops.add(topRpid);
				missTops.push(top);
			}
			for (const c of (Array.isArray(top.children) ? top.children : [])) {
				if (!c || !c.rpid_str) continue;
				const rpid = String(c.rpid_str);
				if (!afterTs(c.savedAt) || cloudKids.has(rpid)) continue;
				cloudKids.add(rpid);
				missKids.push(c);
				// 子评论要有父行才完整：其主评论若不在云端，一并补传（不受水位线限制）
				if (!cloudTops.has(topRpid)) { cloudTops.add(topRpid); missTops.push(top); }
			}
		}

		const total = missTops.length + missKids.length;
		const stat = {
			since, startedAt, total, sent: 0, failed: 0,
			tops: missTops.length, kids: missKids.length,
			users: usersSent, usersDeferred: uc.deferred,
		};
		if (!total) {
			await setFavSyncTs(startedAt);
			return stat;
		}

		// 分块提交：主评论带图转存较慢，每批 5 条；子评论无图，每批 20 条。父行先提交，子行后提交
		const pushChunks = async (items, size, key) => {
			for (let i = 0; i < items.length; i += size) {
				const chunk = items.slice(i, i + size);
				try { await post({ [key]: chunk }); stat.sent += chunk.length; }
				catch (e) {
					stat.failed += chunk.length;
					log(`⚠️ 评论同步补传失败（${key} ${chunk.map(x => x.rpid_str).join(',')}）:`, e);
				}
				prog(`同步中… 已提交 ${stat.sent}/${total} 条${stat.failed ? `，失败 ${stat.failed} 条` : ''}`);
			}
		};
		await pushChunks(missTops, 5, 'tops');
		await pushChunks(missKids, 20, 'children');

		if (!stat.failed) await setFavSyncTs(startedAt);
		else log(`⚠️ 本轮有 ${stat.failed} 条失败，同步时间戳未推进（下次点「评论同步」会重试）`);
		return stat;
	}

	// 从评论渲染节点采集并入库（支持主/子两层）
	async function collectAndSaveFavorite(renderer) {
		const data = renderer && renderer.data;
		if (!data || !data.rpid_str) return { ok: false };
		const isSub = !!(data.parent && String(data.parent) !== '0');
		const entry = await buildEntry(renderer, isSub);
		if (!entry) return { ok: false };
		// 直接收藏主评论 → 按当前默认可见性打标；收藏子回复 → 不动父组已有的隐私设置
		if (!isSub) entry.isPrivate = await getFavDefaultPrivate();
		const list = await getFavorites();
		const parentRpid = isSub ? entry.parent : '';
		let isNew = false, topRef = entry, isSubResult = false;
		if (parentRpid) {
			const mainRenderer = findMainCommentRenderer(renderer);
			const mainEntry = mainRenderer ? await buildEntry(mainRenderer, false) : null;
			if (mainEntry) {
				const r = upsertTopEntry(list, mainEntry);
				topRef = r.ref;
				isNew = upsertChildEntry(topRef, entry);
				isSubResult = true;
			} else {
				const r = upsertTopEntry(list, entry);
				topRef = r.ref; isNew = r.isNew;
			}
		} else {
			const r = upsertTopEntry(list, entry);
			topRef = r.ref; isNew = r.isNew;
		}
		await GM_setValue(FAV_KEY, list);
		if (favSetCache) {
			favSetCache.add(entry.rpid_str);
			if (topRef && topRef !== entry) favSetCache.add(topRef.rpid_str);
		}
		if (favPrivCache) {
			// 星标颜色跟着「整组」走：子评论也按父组的隐私设置上色
			const p = !!(topRef && topRef.isPrivate);
			favPrivCache.set(entry.rpid_str, p);
			if (topRef) favPrivCache.set(topRef.rpid_str, p);
		}
		cacheImagesForEntry(entry);
		if (topRef && topRef !== entry) cacheImagesForEntry(topRef);
		syncFavoriteToCloud(topRef, isSubResult ? entry : null);
		return { ok: true, isNew, entry, topRef, isSub: isSubResult };
	}

	async function doFavorite(abr, btn) {
		const renderer = climbToTag(abr, 'BILI-COMMENT-ACTION-BUTTONS-RENDERER')
			|| climbToTag(abr, 'BILI-COMMENT-RENDERER');
		const res = await collectAndSaveFavorite(renderer);
		if (!res.ok) { showFavToast('⚠️ 未取到评论数据'); return; }
		const priv = !!(res.topRef && res.topRef.isPrivate);
		markFaved(btn, priv);
		const hasPics = res.entry.pictures && res.entry.pictures.length;
		if (res.isSub) showFavToast(priv ? '🔒 已收藏（含上层主评论 · 私人）' : '⭐ 已收藏（含上层主评论）');
		else if (!res.isNew) showFavToast('⭐ 已更新收藏');
		else showFavToast((hasPics ? '已收藏（图片缓存中…）' : '已收藏') + (priv ? ' · 🔒 私人' : ' · 🌐 公开'));
	}

	// 动作栏星星点击入口：未收藏则收藏，已收藏则取消（切换）
	async function handleFavToggle(abr, btn) {
		const renderer = climbToTag(abr, 'BILI-COMMENT-ACTION-BUTTONS-RENDERER')
			|| climbToTag(abr, 'BILI-COMMENT-RENDERER');
		const data = renderer && renderer.data;
		const rpid = data && data.rpid_str;
		if (!rpid) { showFavToast('⚠️ 未取到评论数据'); return; }
		if (favSetCache && favSetCache.has(rpid)) {
			await deleteFavorite(rpid);
			unmarkFaved(btn);
			showFavToast('✖ 已取消收藏');
		} else {
			await doFavorite(abr, btn);
		}
	}

	// ---------- 动作栏常驻「收藏」按钮 ----------
	// 直接插在 #dislike 与 #reply 之间，点一下即收藏 —— 这是唯一的收藏入口。
	// 样式做法：克隆 #reply 这个容器（cloneNode 不会带走 B 站绑在上面的事件监听），
	// 外来节点同样受该影子树的 CSS 作用域管辖，所以布局/悬停态/深色模式都能白捡；
	// 但 B 站可能用 id 选择器写样式，去掉 id 后要顺手把关键布局属性抄过来兜底。
	const FAV_BTN_ATTR = 'data-fav-btn';
	const SVG_NS = 'http://www.w3.org/2000/svg';
	let favBtnNoAnchorWarned = false;

	function starSvg() {
		const svg = document.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 24 24');
		svg.setAttribute('width', '18');
		svg.setAttribute('height', '18');
		svg.setAttribute('aria-hidden', 'true');
		svg.style.display = 'block';
		const p = document.createElementNS(SVG_NS, 'path');
		p.setAttribute('d', 'M12 3.6 14.6 8.9 20.4 9.75 16.2 13.85 17.19 19.66 12 16.9 6.81 19.66 7.8 13.85 3.6 9.75 9.4 8.9Z');
		p.setAttribute('fill', 'none');
		p.setAttribute('stroke', 'currentColor');
		p.setAttribute('stroke-width', '1.6');
		p.setAttribute('stroke-linejoin', 'round');
		svg.appendChild(p);
		return svg;
	}

	// 已收藏=实心蓝星，未收藏=灰色描边星（描边走 currentColor，深色模式与 hover 自动跟 B 站）
	// 坑：B 站的影子 CSS 直接给内层 <button> 设了 color，在宿主 div 上改 color 传不下去，
	// 于是 fill="currentColor" 会解成 B 站自己的灰色（实测 148,153,160）→ 收藏后变成灰星。
	// 所以颜色要写到 button 上，并且已收藏态给 path 写死 fill/stroke，不再依赖 currentColor。
	const FAV_ON_COLOR = '#00aeec';
	const FAV_PRIV_COLOR = '#fb7299';   // B站粉：私人收藏的星标填充色，与发布页的私人标识同色系

	// 三态：未收藏=灰描边；公开收藏=蓝实心；私人收藏=粉实心
	function paintFavBtn(btn, faved, priv) {
		if (!btn) return;
		const inner = btn.querySelector('button') || btn;
		const p = btn.querySelector('path');
		const on = faved ? (priv ? FAV_PRIV_COLOR : FAV_ON_COLOR) : '';
		if (p) {
			p.setAttribute('fill', faved ? on : 'none');
			p.setAttribute('stroke', faved ? on : 'currentColor');
		}
		inner.style.color = on;
		btn.style.color = on;
		btn.dataset.favDone = faved ? '1' : '';
		btn.dataset.favPriv = faved && priv ? '1' : '';
		btn.title = faved ? (priv ? '取消收藏（脚本 · 私人：只有你自己看得到）' : '取消收藏（脚本 · 公开）') : '收藏（脚本）';
		btn.setAttribute('aria-label', btn.title);
	}

	function copyLayout(from, to) {
		const cs = window.getComputedStyle(from);
		['display', 'alignItems', 'gap', 'padding', 'margin', 'height', 'minWidth',
		 'fontSize', 'lineHeight', 'color', 'cursor', 'flexShrink'].forEach(k => { to.style[k] = cs[k]; });
	}

	// 找出某个动作栏里已插入的收藏按钮。
	// 关键：按钮在宿主元素**自己的 shadowRoot** 里，而 el.querySelector 看不见自身影子树，
	// 只查 light DOM 会让幂等判断永远为假 → 每轮复扫多插一颗星。
	function favBtnsIn(abr) {
		const found = [];
		if (abr.shadowRoot) found.push(...abr.shadowRoot.querySelectorAll(`[${FAV_BTN_ATTR}]`));
		found.push(...abr.querySelectorAll(`[${FAV_BTN_ATTR}]`));
		return found;
	}

	// ===== 评论区导航条入口（视频页 / 动态页共用同一套组件）=====
	// 路径：bili-comments → #header > bili-comments-header-renderer → (影子) #navbar
	// 动态页是卡片流，每张展开的评论区都有自己的导航条 → 全页只装一个入口，
	// 判定用「页面上是否已存在我们的按钮」而不是「当前这个导航条有没有」，避免展开第二张又冒一个。
	const NAV_BTN_ATTR = 'data-fav-nav-btn';
	let navBtnWarned = false;

	function commentNavbars() {
		const out = [];
		for (const hr of querySelectorAllDeep(document, 'bili-comments-header-renderer')) {
			const nb = hr.shadowRoot && hr.shadowRoot.querySelector('#navbar');
			if (nb) out.push(nb);
		}
		return out;
	}

	function makeNavbarButton() {
		const btn = document.createElement('div');
		btn.setAttribute(NAV_BTN_ATTR, '1');
		btn.textContent = '⭐ 我的收藏';
		btn.title = '打开本地收藏面板（BiliFavComments）';
		// 不依赖 B 站自己的类名：颜色继承导航条文字，深浅色模式都跟得上；margin-left:auto 让它靠最右
		btn.style.cssText = 'display:inline-flex;align-items:center;gap:4px;flex-shrink:0;'
			+ 'margin-left:auto;padding:2px 10px;border:1px solid rgba(128,128,128,.35);border-radius:999px;'
			+ 'font-size:12px;line-height:1.8;white-space:nowrap;cursor:pointer;user-select:none;'
			+ 'color:inherit;transition:color .15s,border-color .15s,background-color .15s;';
		btn.addEventListener('mouseenter', () => { btn.style.color = '#00aeec'; btn.style.borderColor = '#00aeec'; });
		btn.addEventListener('mouseleave', () => { btn.style.color = ''; btn.style.borderColor = ''; });
		btn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			openFavPopup();
		});
		return btn;
	}

	function injectNavbarButton() {
		const bars = commentNavbars();
		if (!bars.length) {
			if (!navBtnWarned) {           // 评论组件还没渲染出导航条是常态，只提示一次
				navBtnWarned = true;
				log('⏳ 评论区导航条尚未渲染，入口按钮稍后随复扫补上');
			}
			return;
		}
		const has = (nb) => !!nb.querySelector(`[${NAV_BTN_ATTR}]`);
		let placed = bars.some(has);
		for (const nb of bars) {
			if (has(nb)) continue;
			if (placed) continue;          // 已有入口，别在第二张卡片上再放一个
			nb.appendChild(makeNavbarButton());
			placed = true;
		}
	}

	function injectFavActionButtons() {
		if (!favSetCache) return;          // 收藏集合还没加载好，先不插，避免状态全错
		const bars = querySelectorAllDeep(document, 'bili-comment-action-buttons-renderer');
		let inserted = 0, skipped = 0, noAnchor = 0, deduped = 0;
		for (const abr of bars) {
			const existing = favBtnsIn(abr);
			if (existing.length > 1) {     // 自愈：老版本重复插入的残留，只留第一颗
				for (let i = 1; i < existing.length; i++) existing[i].remove();
				deduped += existing.length - 1;
			}
			if (existing.length) { skipped++; continue; }                                  // 幂等：已插过
			const sr = abr.shadowRoot;
			const anchor = sr && sr.querySelector('#reply');
			if (!anchor) { noAnchor++; continue; }                                  // 这一版还没渲染出动作栏，等下次复扫

			const host = anchor.cloneNode(true);
			host.removeAttribute('id');
			host.setAttribute(FAV_BTN_ATTR, '1');
			copyLayout(anchor, host);
			const inner = host.querySelector('button') || host;
			['data-spm', 'data-mod', 'name', 'title', 'aria-label'].forEach(a => { inner.removeAttribute(a); host.removeAttribute(a); });
			inner.textContent = '';
			inner.appendChild(starSvg());
			inner.style.cursor = 'pointer';

			host.addEventListener('click', (e) => {
				e.stopPropagation();                 // B 站在动作栏上用事件委托，必须抢在它前面
				e.preventDefault();
				handleFavToggle(abr, host);          // 收藏 / 取消收藏 切换
			});
			sr.insertBefore(host, anchor);
			const rpidKey = String((abr.data && abr.data.rpid_str) || '');
			paintFavBtn(host, favSetCache.has(rpidKey), !!(favPrivCache && favPrivCache.get(rpidKey)));
			inserted++;
		}
		if (noAnchor && !favBtnNoAnchorWarned) {
			favBtnNoAnchorWarned = true;
			log(`⚠️ 有 ${noAnchor} 个动作栏里找不到 #reply（B 站可能改了结构）：这几条评论暂时没有收藏入口`);
		}
	}

	// ======================================================
	// ============= 收藏查看 / 管理入口 ===================
	// ======================================================
	let favListBodyEl = null;
	let favCountEl = null;
	let favAllList = [];
	let favQuery = '';
	let favSearchEl = null;
	let favPopupEl = null;

	function buildFavRow(item, isChild) {
		const row = createElement('div');

		const head = createElement('div', { style: 'display:flex;align-items:center;gap:10px;margin-bottom:6px;' });
		const unameText = item.uname || '匿名';
		if (item.mid && String(item.mid) !== '0') {
			head.appendChild(createElement('a', {
				textContent: unameText, href: 'https://space.bilibili.com/' + item.mid, target: '_blank', rel: 'noopener',
				title: '个人空间：' + unameText, style: 'font-weight:600;color:#00aeec;text-decoration:none;cursor:pointer;'
			}));
		} else {
			head.appendChild(createElement('span', { textContent: unameText, style: 'font-weight:600;color:#00aeec;' }));
		}
		if (item.location) head.appendChild(createElement('span', { textContent: '· ' + item.location, style: 'font-size:12px;color:#ff9800;flex-shrink:0;' }));
		head.appendChild(createElement('span', {
			textContent: item.ctime ? new Date(item.ctime * 1000).toLocaleString() : '',
			style: 'font-size:12px;color:#aaa;flex:1;'
		}));
		if (item.url) {
			const tip = item.videoTitle || '查看该评论';
			head.appendChild(createElement('a', {
				textContent: tip.length > 30 ? tip.slice(0, 30) + '...' : tip,
				href: item.url, target: '_blank', rel: 'noopener', title: tip,
				style: 'font-size:12px;color:#00aeec;text-decoration:none;flex-shrink:0;'
			}));
		}
		if (item.upName) {
			// UP昵称：B站粉；有 upMid 时链到个人空间，旧数据无此字段则纯文本
			const upTip = 'UP空间：' + item.upName;
			const upStyle = 'font-size:12px;color:#fb7299;text-decoration:none;flex-shrink:0;';
			head.appendChild(item.upMid
				? createElement('a', { textContent: item.upName, href: 'https://space.bilibili.com/' + item.upMid, target: '_blank', rel: 'noopener', title: upTip, style: upStyle })
				: createElement('span', { textContent: item.upName, title: 'UP主：' + item.upName, style: upStyle }));
		}
		// 私人行给个粉色小标签：与动作栏的粉星、发布页的私人标识同一套语义
		if (!isChild && item.isPrivate) {
			head.appendChild(createElement('span', {
				textContent: '🔒 私人', title: '这条收藏只有你自己能在发布页看到',
				style: 'font-size:11px;color:#fb7299;background:rgba(251,114,153,.12);border-radius:999px;padding:1px 8px;flex-shrink:0;'
			}));
		}
		head.appendChild(createButton('删除', () => deleteFavorite(item.rpid_str), 'background:#ff5722;color:#fff;padding:2px 12px;font-size:12px;border:none;border-radius:4px;cursor:pointer;'));
		row.appendChild(head);

		const hasPics = Array.isArray(item.pictures) && item.pictures.length > 0;
		const contentText = item.content || (hasPics ? '' : '(无内容)');
		if (contentText) {
			row.appendChild(createElement('div', { textContent: contentText, style: 'font-size:14px;color:#333;margin-bottom:6px;word-break:break-all;' }));
		}

		if (hasPics) {
			const picRow = createElement('div', { style: 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px;min-height:24px;' });
			for (const pic of item.pictures) {
				const thumb = typeof pic === 'string' ? pic : (pic.thumb || pic.orig);
				const orig = typeof pic === 'string' ? pic : (pic.orig || pic.thumb);
				const a = createElement('a', { href: toHttps(orig), target: '_blank', rel: 'noopener', style: 'display:block;line-height:0;' });
				const img = createElement('img', { loading: 'lazy', decoding: 'async', style: 'max-width:100%;max-height:320px;height:auto;border-radius:6px;border:1px solid #eee;display:block;' });
				a.appendChild(img);
				picRow.appendChild(a);
				// 展示只查缩略图缓存（事务减半）；原图在点击时才查本地缓存
				(async () => {
					if (!thumb) return;
					const tb = await idbGet(thumb);
					if (tb) { const u = URL.createObjectURL(tb); favObjectUrls.push(u); img.src = u; }
					else img.src = toHttps(thumb);
				})();
				a.addEventListener('click', async (e) => {
					if (!orig) return;
					const ob = await idbGet(orig);
					if (ob) {
						e.preventDefault();
						const u = URL.createObjectURL(ob);
						favObjectUrls.push(u);
						window.open(u, '_blank');
					}
				});
			}
			row.appendChild(picRow);
		}
		return row;
	}

	// 一条主评论 + 它的全部子评论 = 一个容器（缩进 + 半透明横线区分子评论）
	function buildFavGroup(item) {
		const group = createElement('div', {
			style: 'background:#fff;border:1px solid #eee;border-radius:10px;padding:10px 12px;margin-bottom:12px;content-visibility:auto;contain-intrinsic-size:auto 160px;'
		});
		group.appendChild(buildFavRow(item, false));

		const kids = Array.isArray(item.children)
			? item.children.slice().sort((a, b) => (a.ctime || 0) - (b.ctime || 0))
			: [];
		if (kids.length) {
			const wrap = createElement('div', {
				style: 'margin-top:8px;padding:8px 0 0 14px;border-top:1px solid rgba(0,0,0,0.06);border-left:2px solid rgba(0,174,236,0.15);'
			});
			kids.forEach((c, i) => {
				const row = buildFavRow(inheritParentFields(c, item), true);
				if (i > 0) {
					row.style.borderTop = '1px solid rgba(0,0,0,0.06)';
					row.style.marginTop = '8px';
				}
				wrap.appendChild(row);
			});
			group.appendChild(wrap);
		}
		return group;
	}

	function renderFavList(body, list) {
		revokeFavObjectUrls();
		body.innerHTML = '';
		if (!list.length) {
			body.appendChild(createElement('div', {
				textContent: '还没有收藏任何评论。在评论区点「更多 → 收藏」试试～',
				style: 'padding:40px;text-align:center;color:#999;font-size:14px;'
			}));
			return;
		}
		list = list.slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
		for (const item of list) body.appendChild(buildFavGroup(item));
	}

	async function deleteFavorite(rpid) {
		const list = await getFavorites();
		// 先删顶层（连带其子评论）
		let next = list.filter(x => x && x.rpid_str !== rpid);
		// 再把它从任何父条目的 children 中删掉
		for (const top of next) {
			if (Array.isArray(top.children)) {
				top.children = top.children.filter(c => c && c.rpid_str !== rpid);
			}
		}
		await GM_setValue(FAV_KEY, next);
		if (favSetCache) favSetCache.delete(rpid);
		if (favPrivCache) favPrivCache.delete(rpid);
		await refreshFavPanel();
		showFavToast('🗑️ 已删除');
	}

	function exportFavorites() {
		getFavorites().then(list => {
			if (!list.length) { showFavToast('没有可导出的收藏'); return; }
			const json = JSON.stringify(list, null, 2);
			const blob = new Blob([json], { type: 'application/json' });
			const url = URL.createObjectURL(blob);
			const a = document.createElement('a');
			a.href = url;
			const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
			a.download = `BiliFavorites_${ts}.json`;
			document.body.appendChild(a);
			a.click();
			document.body.removeChild(a);
			URL.revokeObjectURL(url);
			log(`✅ 已导出 ${list.length} 条收藏`);
		});
	}

	// 一次性迁移通道：从 BiliSmartComment「导出配置」生成的备份文件中导入收藏
	// 兼容两种格式：{favorites:[...]} 全量备份 / [...] 纯收藏数组（旧 BiliFavorites_*.json 导出）
	// 按 rpid_str 合并（upsert），不覆盖新脚本里已有的收藏
	function importFavoritesFromFile() {
		const input = document.createElement('input');
		input.type = 'file';
		input.accept = '.json';
		input.onchange = (e) => {
			const file = e.target.files[0];
			if (!file) return;
			const reader = new FileReader();
			reader.onload = async (event) => {
				try {
					const data = JSON.parse(event.target.result);
					const imported = Array.isArray(data) ? data : (data && Array.isArray(data.favorites) ? data.favorites : null);
					if (!imported) {
						showFavToast('⚠️ 文件中没有收藏数据');
						return;
					}
					const list = await getFavorites();
					let added = 0, updated = 0, skipped = 0;
					for (const entry of imported) {
						const clean = sanitizeTop(entry);
						if (!clean) { skipped++; continue; }
						const r = upsertTopEntry(list, clean);
						r.isNew ? added++ : updated++;
					}
					await GM_setValue(FAV_KEY, list);
					await loadFavCache();
					await refreshFavPanel();
					log(`✅ 收藏导入完成: 新增 ${added} / 更新 ${updated}` + (skipped ? ` / 跳过 ${skipped}` : ''));
					showFavToast(`✅ 导入完成：新增 ${added}，更新 ${updated}`);
				} catch (err) {
					console.error('导入收藏失败:', err);
					showFavToast('❌ 导入失败: ' + err.message);
				}
			};
			reader.readAsText(file);
		};
		input.click();
	}

	// 收藏日期条件：支持 20260511 / 2026-05-11 / 2026/05/11 / 2026.05.11（savedAt 为毫秒时间戳）
	function parseDateCond(text) {
		const t = String(text).trim().replace(/[./]/g, '-');
		let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
		if (!m) m = t.match(/^(\d{4})(\d{2})(\d{2})$/);
		if (!m) return null;
		const y = +m[1], mo = +m[2], d = +m[3];
		const start = new Date(y, mo - 1, d).getTime();
		return { start: start, end: start + 24 * 3600 * 1000 };
	}

	// 字段别名 → 可搜索文本
	function favFieldText(item, field) {
		switch (field) {
			case 'uname': case 'user': case 'name': return item.uname || '';
			case 'up': case 'upname': return item.upName || '';
			case 'content': case 'text': case 'msg': return item.content || '';
			case 'title': case 'video': case 'videotitle': return item.videoTitle || '';
			default: return [item.uname, item.content, item.videoTitle, item.upName].join(' ');
		}
	}

	// 解析查询：支持 key:value、"带空格"、以及裸词（裸词跨全字段）
	function parseFavQuery(q) {
		const conds = [];
		const re = /(?:(uname|user|name|upname|up|content|text|msg|videotitle|video|title|date|saved|save|day|收藏|日期)\s*:\s*(?:"([^"]*)"|(\S+)))|(?:"([^"]*)"|(\S+))/gi;
		let m;
		while ((m = re.exec(q)) !== null) {
			if (m[1]) {
				const key = m[1].toLowerCase();
				const field = (key === 'date' || key === 'saved' || key === 'save' || key === 'day' || key === '收藏' || key === '日期') ? 'saved_at' : key;
				conds.push({ field: field, text: (m[2] || m[3] || '').toLowerCase() });
			} else conds.push({ field: 'any', text: (m[4] || m[5] || '').toLowerCase() });
		}
		return conds;
	}

	// 子评论缺失的视频标题/UP主从父级继承（仅用于展示/搜索的视图，不落库）
	function inheritParentFields(child, parent) {
		if (!parent) return child;
		const v = Object.assign({}, child);
		if (v.videoTitle === undefined) v.videoTitle = parent.videoTitle;
		if (v.upName === undefined) v.upName = parent.upName;
		return v;
	}

	function itemMatches(item, conds) {
		return conds.every(c => {
			if (!c.text) return true;
			if (c.field === 'saved_at') {
				const r = parseDateCond(c.text);
				return r ? (item.savedAt >= r.start && item.savedAt < r.end) : true;
			}
			return favFieldText(item, c.field).toLowerCase().includes(c.text);
		});
	}

	function filterFavList(list, q) {
		const conds = parseFavQuery(q || '');
		if (!conds.length) return list;
		const out = [];
		for (const item of list) {
			if (itemMatches(item, conds)) { out.push(item); continue; }
			const kids = Array.isArray(item.children) ? item.children : [];
			const matchKids = kids.map(k => inheritParentFields(k, item)).filter(k => itemMatches(k, conds));
			if (matchKids.length) out.push(Object.assign({}, item, { children: matchKids }));
		}
		return out;
	}

	function applyFavFilter() {
		if (!favListBodyEl || !favListBodyEl.isConnected) return;
		const filtered = filterFavList(favAllList, favQuery);
		renderFavList(favListBodyEl, filtered);
		if (favCountEl) {
			favCountEl.textContent = favQuery.trim()
				? `匹配 ${filtered.length} / 共 ${favAllList.length} 条`
				: `共 ${favAllList.length} 条`;
		}
	}

	async function refreshFavPanel() {
		if (!favListBodyEl || !favListBodyEl.isConnected) return;
		favAllList = await getFavorites();
		applyFavFilter();
	}

	// 收藏面板工具栏上的 ☁️ 授权徽标（面板没开时静默跳过）
	let favCloudChipEl = null;

	function refreshFavCloudChip() {
		if (!favCloudChipEl || !favCloudChipEl.isConnected) return;
		getFavAuth().then(a => {
			const exp = a && a.expires_at ? new Date(a.expires_at) : null;
			const expired = !!exp && exp.getTime() < Date.now();
			favCloudChipEl.textContent = a ? (expired ? '☁️ 待续期' : '☁️ 已授权') : '☁️ 未授权';
			favCloudChipEl.style.color = a ? (expired ? '#faad14' : '#52c41a') : '#ff4d4f';
			favCloudChipEl.title = a
				? '云端同步已授权' + (exp ? '（有效期至 ' + exp.toLocaleString() + '）' : '') + '，点击管理'
				: '点击配置云端同步（一键授权 / 导入令牌）';
		});
	}

	// 授权状态变化的统一出口：谁在显示就刷新谁（由 saveFavAuth 调用）
	function notifyAuthChanged() {
		refreshCloudAuthStatus();
		refreshFavCloudChip();
	}

	// 默认可见性开关的外观：私人用 B站粉，与星标 / 发布页标识同一套颜色语言
	function paintPrivChip(chip, priv) {
		if (!chip) return;
		chip.dataset.priv = priv ? '1' : '';
		chip.textContent = priv ? '🔒 新收藏：私人' : '🌐 新收藏：公开';
		chip.style.background = priv ? 'rgba(251,114,153,.12)' : '#f5f5f5';
		chip.style.color = priv ? '#fb7299' : '#666';
		chip.style.borderColor = priv ? 'rgba(251,114,153,.45)' : '#ddd';
		chip.title = priv
			? '当前：新收藏默认为「私人」—— 只有你自己能在发布页看到。点击切回公开'
			: '当前：新收藏默认为「公开」—— 所有访客可见。点击改为私人';
	}

	function buildFavoritesPanel() {
		const panel = document.createElement('div');
		panel.style.cssText = 'padding: 0 10px;';

		const toolbar = createElement('div', { style: 'display:flex;gap:10px;align-items:center;margin-bottom:12px;' });
		favCountEl = createElement('span', { className: 'fav-count', textContent: '加载中…', style: 'font-size:13px;color:#888;white-space:nowrap;' });
		toolbar.appendChild(favCountEl);
		favSearchEl = createElement('input', {
			type: 'search',
			placeholder: '搜索 昵称/内容/标题/UP/日期；支持 uname: upname: content: title: date:2026-09-05',
			style: 'flex:1; min-width:160px; border:1px solid #ccc; border-radius:6px; padding:4px 10px; font-size:13px;',
			oninput: (e) => { favQuery = e.target.value; applyFavFilter(); }
		});
		toolbar.appendChild(favSearchEl);
		toolbar.appendChild(createButton('🖼 缓存全图', () => cacheAllImages(), 'background:#67c23a;color:#fff;padding:4px 8px;font-size:13px;border:none;border-radius:6px;cursor:pointer;'));
		toolbar.appendChild(createButton('📥 导出', exportFavorites, 'background:#00aeec;color:#fff;padding:4px 8px;font-size:13px;border:none;border-radius:6px;cursor:pointer;'));
		toolbar.appendChild(createButton('📤 导入', importFavoritesFromFile, 'background:#ff9800;color:#fff;padding:4px 8px;font-size:13px;border:none;border-radius:6px;cursor:pointer;'));
		// 定位自检：常驻按钮到底插进去没有、卡在哪一步，一眼看到
		const selfCheckBtn = createButton('🔍', () => {
			const stat = () => {
				const bars = querySelectorAllDeep(document, 'bili-comment-action-buttons-renderer');
				const counts = bars.map(b => favBtnsIn(b).length);
				const navs = commentNavbars();
				return `动作栏 ${bars.length}｜有星 ${counts.filter(n => n >= 1).length}｜重复 ${counts.filter(n => n > 1).length}｜缺#reply ` +
					`${bars.filter(b => b.shadowRoot && !b.shadowRoot.querySelector('#reply')).length}｜已收藏 ${favSetCache ? favSetCache.size : '?'}` +
					`｜导航条 ${navs.length} 装 ${navs.filter(nb => nb.querySelector(`[${NAV_BTN_ATTR}]`)).length}`;
			};
			const before = stat();
			findAndEnhanceCommentArea();   // 补插 + 去重
			const after = stat();
			log('🔍 定位自检 补插前:', before, '\n🔍 定位自检 补插后:', after);
			showFavToast(before === after ? '✅ ' + after : `修复前 ${before}`);
			if (before !== after) setTimeout(() => showFavToast('修复后 ' + after), 1800);
		}, 'padding:4px 8px;font-size:13px;background:#f5f5f5;color:#666;border:1px solid #ddd;border-radius:6px;cursor:pointer;');
		// 注意：别写成 appendChild(createButton(...).title = '…') —— 赋值表达式的值是右边那个字符串，
		// 会变成 appendChild(字符串) 直接抛错，整个面板都渲染不出来
		selfCheckBtn.title = '定位自检：统计动作栏收藏按钮注入情况，并补插/去重一轮';
		toolbar.appendChild(selfCheckBtn);
		// 默认可见性开关：决定「新收藏」是公开还是私人（私人 = 发布页上只有你自己能看到）
		const privChip = createButton('🌐 新收藏：公开', async () => {
			const next = privChip.dataset.priv !== '1';
			await setFavDefaultPrivate(next);
			paintPrivChip(privChip, next);
			showFavToast(next ? '🔒 之后的新收藏默认为私人（只有你能在发布页看到）' : '🌐 之后的新收藏默认为公开');
		}, 'padding:4px 10px;font-size:12px;border:1px solid #ddd;border-radius:12px;cursor:pointer;');
		toolbar.appendChild(privChip);
		getFavDefaultPrivate().then(v => paintPrivChip(privChip, v));   // 面板重建时异步刷回当前设置
		// 云端状态指示：点击直达云端同步设置
		const cloudChip = createButton('☁️ …', openCloudConfigPopup, 'background:#f5f5f5;color:#666;padding:4px 10px;font-size:12px;border:1px solid #ddd;border-radius:12px;cursor:pointer;');
		toolbar.appendChild(cloudChip);
		favCloudChipEl = cloudChip;
		refreshFavCloudChip();   // 之后授权变化由 saveFavAuth → notifyAuthChanged 自动刷回来
		panel.appendChild(toolbar);

		favListBodyEl = createElement('div', { className: 'fav-list-body', style: 'max-height:420px;overflow-y:auto;' });
		panel.appendChild(favListBodyEl);

		favQuery = '';
		refreshFavPanel();
		return panel;
	}

	// 云端同步设置弹窗状态
	let cloudPopupEl = null;
	let cloudAuthStatusEl = null;

	// 刷新弹窗里的授权状态文案（授权回传到达时也会调用）
	// 注意：GM_getValue 不一定返回 Promise（有些上下文里直接同步给值），取值一律用 await，别链 .then
	// —— 否则会抛 "GM_getValue(...).then is not a function"，这一行状态就永远停在「检查中...」
	function refreshCloudAuthStatus() {
		if (!cloudAuthStatusEl || !cloudAuthStatusEl.isConnected) return;
		getFavAuth().then(async a => {
			if (!a) {
				cloudAuthStatusEl.textContent = '🔑 授权状态：未授权';
				cloudAuthStatusEl.style.color = '#ff4d4f';
				return;
			}
			const exp = a.expires_at ? new Date(a.expires_at) : null;
			const expired = exp && exp.getTime() < Date.now();
			const last = Number(await GM_getValue(FAV_AUTH_RENEW_KEY, 0)) || 0;
			if (!cloudAuthStatusEl || !cloudAuthStatusEl.isConnected) return;
			const lastTxt = last ? Math.max(0, Math.round((Date.now() - last) / 60000)) + ' 分钟前' : '从未';
			cloudAuthStatusEl.textContent = (expired
				? '🔑 授权状态：已过期（下次调用云端时自动续期）'
				: '🔑 授权状态：已授权' + (exp ? '（有效期至 ' + exp.toLocaleString() + '）' : ''))
				+ `｜上次续期 ${lastTxt}`;
			cloudAuthStatusEl.style.color = expired ? '#faad14' : '#52c41a';
		});
	}

	// 云端同步设置：同步地址已内置（SYNC_URL），这里只管账号授权
	//   途径 A 一键授权（打开授权页，登录后自动回传）  ←  推荐
	//   途径 B 手动导入令牌（授权弹窗被拦截时的兜底）
	//   连接自检：独立功能，向云端函数发一次空请求验证地址与登录态
	function openCloudConfigPopup() {
		if (cloudPopupEl && cloudPopupEl.isConnected) {
			cloudPopupEl.remove();
			cloudPopupEl = null;
			return;
		}
		const container = createPopupContainer('bili-fav-cloud-popup', '560px');
		cloudPopupEl = container;
		addCloseX(container, () => { container.remove(); cloudPopupEl = null; });

		const title = createElement('h3', { textContent: '☁️ 云端同步设置', style: COMMON_STYLES.title });
		container.appendChild(title);
		draggableManager.makeDraggable(container, title);

		cloudAuthStatusEl = createElement('div', {
			textContent: '🔑 授权状态：检查中…',
			style: 'font-size:12px;margin:0 0 12px 0;min-height:18px;'
		});
		container.appendChild(cloudAuthStatusEl);

		// 底部共用反馈行（三个分区的操作结果都写在这里）
		const status = createElement('div', {
			textContent: '', style: 'font-size:12px;margin-top:4px;min-height:18px;color:#888;word-break:break-all;'
		});
		const say = (color, text) => { status.style.color = color; status.textContent = text; };

		// 分区卡片：标题 + 说明 + 控件（控件由调用方 append 进返回值）
		function addSection(tagText, descText) {
			const box = createElement('div', {
				style: 'border:1px solid #eee;border-radius:8px;padding:10px 12px;margin-bottom:10px;background:#fafbfc;'
			});
			box.appendChild(createElement('div', {
				textContent: tagText,
				style: 'font-size:13px;font-weight:600;color:#333;margin-bottom:3px;'
			}));
			box.appendChild(createElement('div', {
				textContent: descText,
				style: 'font-size:12px;color:#888;line-height:1.6;margin-bottom:8px;'
			}));
			container.appendChild(box);
			return box;
		}
		const btnRow = () => createElement('div', { style: 'display:flex;justify-content:flex-end;' });

		// ── 途径 A：一键授权
		const boxA = addSection('途径 A · 一键授权（推荐）',
			'打开授权页登录（邮箱 / Google / GitHub），登录后点「发送授权到脚本」，令牌自动回传给本脚本。');
		const authBtn = createButton('🔑 打开授权页', () => {
			window.open(AUTH_PAGE_URL + '?auth_for_script=1', 'bili_fav_auth');
			say('#888', '已打开授权页：在窗口里登录并点「发送授权到脚本」，本窗口会自动刷新授权状态。');
		}, 'background:#67c23a;color:#fff;border-color:#67c23a;padding:4px 16px;');
		const rowA = btnRow();
		rowA.appendChild(authBtn);
		boxA.appendChild(rowA);

		// ── 途径 B：手动导入令牌
		const boxB = addSection('途径 B · 手动导入令牌（备用）',
			'途径A登录弹窗被浏览器拦截时改用这个：在发布页 https://vq8r8gj5.qwenwork.host/?auth_for_script=1 登录后点「🔑 授权脚本」→ 复制生成的 JSON 令牌 → 粘贴到下面导入。');
		const codeInput = createElement('textarea', {
			rows: '2',
			placeholder: '{"source":"bili-fav-auth","access_token":"…","refresh_token":"…","expires_at":…}',
			style: 'width:100%;box-sizing:border-box;border:1px solid #ccc;border-radius:4px;padding:6px 8px;font-size:11px;font-family:monospace;resize:vertical;'
		});
		boxB.appendChild(codeInput);
		const importBtn = createButton('📥 导入令牌', async () => {
			let d = null;
			try { d = JSON.parse(codeInput.value.trim()); } catch (e) { /* 格式错走下方统一提示 */ }
			const auth = await applyAuthPayload(d);
			if (!auth) {
				say('#ff4d4f', '❌ 令牌格式不对：应为发布页导出的 JSON（含 access_token 与 refresh_token）。');
				return;
			}
			refreshCloudAuthStatus();
			const exp = auth.expires_at ? new Date(auth.expires_at).toLocaleString() : '';
			say('#52c41a', '✅ 令牌已导入' + (exp ? '（有效期至 ' + exp + '，之后自动续期）' : '') + '，可用下方「测试连接」验证。');
			codeInput.value = '';
		}, 'background:#00aeec;color:#fff;border-color:#00aeec;padding:4px 16px;margin-top:8px;');
		const rowB = btnRow();
		rowB.appendChild(importBtn);
		boxB.appendChild(rowB);

		// ── 连接自检 + 评论同步（独立功能，不参与授权流程）
		const boxC = addSection('连接自检与评论同步',
			`测试连接：向云端函数发一次空请求，只验证「地址可达 + 登录态被接受」，不会写入任何数据。
评论同步：单向同步，仅把云端没有的收藏提交上云，不从云端向下同步、也不删除云端条目。
每轮同步还会顺带补齐/刷新收藏涉及的用户资料快照（发布页悬停名片的数据源，同一人 7 天内不重抓）。`);
		const syncLine = createElement('div', {
			textContent: '⏱ 上次同步：检查中…',
			style: 'font-size:12px;color:#888;margin-bottom:8px;'
		});
		const renderSyncLine = () => {
			getFavSyncTs().then(ts => {
				syncLine.textContent = ts
					? '⏱ 上次同步：' + new Date(ts).toLocaleString() + '（此后的收藏都会与云端比对）'
					: '⏱ 上次同步：从未同步过（首次点击会把本地全部收藏与云端比对一遍）';
			});
		};
		boxC.appendChild(syncLine);
		const testBtn = createButton('🔌 测试连接', async () => {
			say('#888', '测试中…');
			try {
				const token = await ensureFavAuthToken();
				if (!token) {
					say('#ff4d4f', '❌ 尚未授权或授权失效：请先走途径 A 或途径 B。');
					refreshCloudAuthStatus();
					return;
				}
				const r = await fetch(SYNC_URL, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
					body: '{}',
				});
				const j = await r.json().catch(() => null);
				if (r.status === 401) {
					say('#ff4d4f', '❌ 401：登录态被拒（可能已在发布页登出），请重新授权。');
					refreshCloudAuthStatus();
				} else if (r.ok || (j && j.error === '缺少条目')) {
					say('#52c41a', '✅ 链路正常（可以在B站评论区收藏评论并同步到云端）');
				} else {
					say('#faad14', '⚠️ HTTP ' + r.status + (j ? ' 返回: ' + JSON.stringify(j) : ''));
				}
			} catch (e) {
				say('#ff4d4f', '❌ 请求失败：函数未部署或网络受限。' + e.message);
			}
		}, 'background:#ff9800;color:#fff;border-color:#ff9800;padding:4px 16px;');
		const syncBtn = createButton('🔄 评论同步', async () => {
			syncBtn.disabled = true;
			syncBtn.style.opacity = '0.6';
			say('#888', '同步中…');
			try {
				const st = await runFavCloudSync(msg => say('#888', msg));
				const uTxt = st.users ? `，用户资料 ${st.users} 人` : (st.usersDeferred ? '' : '');
				const dTxt = st.usersDeferred ? `（还有 ${st.usersDeferred} 人待补，再点一次继续）` : '';
				if (!st.total) say('#52c41a', '✅ 评论已是最新：本地没有云端缺失的条目。' + uTxt.replace(/^，/, '') + dTxt);
				else if (st.failed) say('#ff4d4f', `⚠️ 已补传 ${st.sent}/${st.total} 条，失败 ${st.failed} 条：时间戳未推进，处理后再接着点「评论同步」即可续传。${uTxt}${dTxt}`);
				else say('#52c41a', `✅ 同步完成：补传 ${st.total} 条（主评论 ${st.tops} / 子评论 ${st.kids}）${uTxt}，同步时间戳已更新。${dTxt}`);
			} catch (e) {
				say('#ff4d4f', '❌ 同步失败：' + (e && e.message ? e.message : String(e)));
			} finally {
				syncBtn.disabled = false;
				syncBtn.style.opacity = '';
				renderSyncLine();
			}
		}, 'background:#00aeec;color:#fff;border-color:#00aeec;padding:4px 16px;');
		const rowC = createElement('div', { style: 'display:flex;justify-content:flex-end;gap:8px;' });
		rowC.appendChild(testBtn);
		rowC.appendChild(syncBtn);
		boxC.appendChild(rowC);

		container.appendChild(status);

		document.body.appendChild(container);
		refreshCloudAuthStatus();
		renderSyncLine();
	}
	
	// 独立管理窗口（原为 BiliSmartComment 设置弹窗里的"我的收藏"标签页）
	function openFavPopup() {
		if (favPopupEl && favPopupEl.isConnected) {
			favPopupEl.remove();
			favPopupEl = null;
			return;
		}
		const container = createPopupContainer('bili-fav-comments-popup', '760px');
		favPopupEl = container;
		addCloseX(container, () => { container.remove(); favPopupEl = null; });

		const title = createElement('h3', {
			textContent: '我的收藏',
			style: COMMON_STYLES.title
		});
		container.appendChild(title);
		draggableManager.makeDraggable(container, title);

		// buildFavoritesPanel 内部的 refreshFavPanel 会因此时面板尚未挂载而早退，挂载完成后需再刷一次
		document.body.appendChild(container);
		container.appendChild(buildFavoritesPanel());
		refreshFavPanel();
	}

	// ======================================================
	// ============= 页面监听（只服务收藏注入）=============
	// ======================================================

	function findAndEnhanceCommentArea() {
		try {
			injectFavActionButtons();
		} catch (e) {
			console.error('注入动作栏收藏按钮出错:', e);
		}
		try {
			injectNavbarButton();
		} catch (e) {
			console.error('注入导航条入口按钮出错:', e);
		}
	}

	// 为 #commentapp 绑定点击/聚焦监听，捕获用户激活输入框的时机
	// focusin 会从 shadow DOM 内部冒泡到宿主元素，可穿透 shadow DOM 边界
	function bindCommentAppEvents(commentApp) {
		const handler = () => {
			clearTimeout(window.biliFavCommentsTimer);
			window.biliFavCommentsTimer = setTimeout(() => {
				findAndEnhanceCommentArea();
			}, 300);
		};
		commentApp.addEventListener('focusin', handler);
		commentApp.addEventListener('click', handler);
	}

	function isDynamicPage() {
		return window.location.hostname === 't.bilibili.com' ||
			window.location.pathname.startsWith('/opus/') ||
			document.querySelector('.bili-dyn-home, .bili-dyn-item') !== null;
	}

	// 使用MutationObserver监控页面变化（根据URL区分监控目标）
	function initObserver() {
		const isDyn = isDynamicPage();
		log(`当前页面类型: ${isDyn ? '动态页' : '视频页'}`);

		const observer = new MutationObserver(() => {
			clearTimeout(window.biliFavCommentsMutTimer);
			window.biliFavCommentsMutTimer = setTimeout(() => {
				findAndEnhanceCommentArea();
			}, 600);
		});

		const observerConfig = { childList: true, subtree: true };

		let targets = [];

		if (!isDyn) {
			// 视频页优先监控 #commentapp
			const commentApp = document.getElementById('commentapp');
			if (commentApp) {
				targets.push(commentApp);
			}
		} else {
			// 动态页：监控所有 bili-dyn-item（最可靠）
			let dynItems = document.querySelectorAll('.bili-dyn-item');
			targets = Array.from(dynItems);

			// 如果一个都没找到，fallback 到 body
			if (targets.length === 0) {
				targets = [document.body]; // 让 bodyObserver 接管
			}
		}

		// 如果没找到目标，先监控 body
		if (targets.length > 0) {
			targets.forEach(target => {
				observer.observe(target, observerConfig);
				if (target.id === 'commentapp') {
					bindCommentAppEvents(target);
				}
			});
			log(`✅ 已启动 ${isDyn ? '动态页' : '视频页'} Observer`);
		} else {
			const bodyObserver = new MutationObserver(() => {
				const newTargets = isDyn
				? document.querySelectorAll('.bili-comment-container, .bili-dyn-comment')
				: [document.getElementById('commentapp')].filter(Boolean);

				if (newTargets.length > 0) {
					bodyObserver.disconnect();
					newTargets.forEach(target => {
						observer.observe(target, observerConfig);
						if (target.id === 'commentapp') {
							bindCommentAppEvents(target);
						}
					});
					log(`✅ 已启动 ${isDyn ? '动态页' : '视频页'} Observer`);
				}
			});
			bodyObserver.observe(document.body, { childList: true, subtree: true });
			log(`⏳ 等待${isDyn ? '动态页' : '#commentapp'}挂载...`);
		}
	}

	// 初始化
	function init() {
		log('🚀 BiliFavComments 初始化...');
		loadFavCache();
		GM_registerMenuCommand('⭐ 我的收藏', openFavPopup);
		GM_registerMenuCommand('☁️ 云端设置', openCloudConfigPopup);
		installAuthMessageListener();   // 接收发布页回传的授权令牌
		initObserver();

		setTimeout(() => {
			findAndEnhanceCommentArea();
		}, 4000);
	}

	// 页面加载完成后初始化
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else init();
})();
