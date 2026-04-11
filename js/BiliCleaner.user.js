// ==UserScript==
// @name         BiliCleaner
// @namespace    https://greasyfork.org/scripts/511437/
// @description  隐藏B站动态瀑布流中的广告、评论区广告、充电内容以及美化首页
// @version      2.6.0
// @author       chemhunter
// @match        *://t.bilibili.com/*
// @match        *://space.bilibili.com/*
// @match        *://www.bilibili.com/*
// @match        *://live.bilibili.com/*
// @match        *://message.bilibili.com/*
// @connect      cdn.jsdelivr.net
// @connect      raw.githubusercontent.com
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// @grant        GM_getValue
// @icon         https://i0.hdslb.com/bfs/static/jinkela/long/images/favicon.ico
// @license      GPL-3.0 License
// @run-at       document-start
// @noframes
// @downloadURL https://update.greasyfork.org/scripts/511437/BiliCleaner.user.js
// @updateURL https://update.greasyfork.org/scripts/511437/BiliCleaner.meta.js
// ==/UserScript==

(function() {
    'use strict';

    // --- 新增：声明全局变量 ---
    let keywordRegex, keywordRegexGlobal, userSettings, biliAdWordsConfig, whiteList, messageDiv;
    let commentAppObserver, dynamicPanelObserver, panelCardObserver, setupIntervalId;
    let lastPathname = '';
    let hiddenAdCount = 0;
    let lastActiveUpName = null;
    let setMainWidth = false;
    let liveGiftObserver = null;

    // --- 1. 定义默认配置与用户设置 (细化版) ---
    const defaultSettings = {
        global: {
            label: "🖥️ 全局与首页_屏蔽项",
            enable: true,
            sub: {
                swipe: { label: "首页大屏轮播", enable: true },
                feed: { label: "首页推广动态卡片", enable: true },
                nav: { label: "导航栏广告/会员入口", enable: true },
                sidebar: { label: "侧边栏：热搜、公告等", enable: true }, // 合并了视频页和动态页的侧边栏
            }
        },
        dynamic: {
            label: "⚡ 动态瀑布流_屏蔽项",
            enable: true,
            sub: {
                goods: { label: "商品推广", enable: true },
                charge: { label: "充电专属", enable: true },
                reverse: { label: "预约动态", enable: true },
                widen: { label: "动态页面宽屏美化", enable: true },
                popup: { label: "导航栏悬浮”动态“窗", enable: true } // 新增：控制 watchDynamicAllPanel
            }
        },
        comment: {
            label: "📺 视频评论区_屏蔽项",
            enable: true,
            sub: {
                adBlock: { label: "评论区置顶广告", enable: true },
                banner: { label: "评论区上方活动横幅", enable: true } // 新增：控制 .activity-m-v1 等
            }
        },
        live: {
            label: "🎥 直播间_屏蔽项",
            enable: true,
            sub: {
                rank: { label: "上方榜单精简", enable: true },
                giftTip: { label: "聊天栏礼物播报", enable: true },
                giftBar: { label: "下方礼物栏隐藏", enable: true },
                recommend: { label: "下方直播推荐隐藏", enable: true }
            }
        }
    };

    function synchronizeSettings(defaults, stored) {
        // 如果 stored 不是对象或为空，则直接复制 defaults 的副本
        if (!stored || typeof stored !== 'object') {
            return JSON.parse(JSON.stringify(defaults)); // 深拷贝
        }

        const result = {};
        for (let key in defaults) {
            const defaultCategory = defaults[key];
            const storedCategory = stored[key];

            // 创建新的分类对象，以默认分类为基础
            result[key] = {
                label: defaultCategory.label,
                enable: storedCategory && typeof storedCategory.enable === 'boolean' ? storedCategory.enable : defaultCategory.enable,
                sub: {}
            };

            if (defaultCategory.sub) {
                for (let subKey in defaultCategory.sub) {
                    const defaultSub = defaultCategory.sub[subKey];
                    const storedSub = storedCategory && storedCategory.sub ? storedCategory.sub[subKey] : null;

                    result[key].sub[subKey] = {
                        label: defaultSub.label,
                        enable: storedSub && typeof storedSub.enable === 'boolean' ? storedSub.enable : defaultSub.enable
                    };
                }
            }
        }
        return result;
    }

    // 定义统一的存储接口
    const storage = {
        get(key, defaultValue = null) {
            try {
                const value = GM_getValue(key, null);
                if (value === null) return defaultValue;
                if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
                    try { return JSON.parse(value); } catch(e) { return value; }
                }
                return value;
            } catch(e) {
                console.error('GM_getValue error', e);
                const local = localStorage.getItem(key);
                return local ? JSON.parse(local) : defaultValue;
            }
        },
        set(key, value) {
            try {
                GM_setValue(key, JSON.stringify(value));
            } catch(e) {
                console.error('GM_setValue error', e);
                localStorage.setItem(key, JSON.stringify(value));
            }
        }
    };

    function migrateFromLocalStorage() {
        const keysConfig = {
            'biliCleanerSettings': { type: 'object', strategy: 'overwrite_if_empty', targetKey: 'biliCleanerSettings'},
            'biliUpWhiteList': { type: 'array', strategy: 'union', targetKey: 'biliUpWhiteList' },
            'localConfig': { type: 'object', strategy: 'keep_newest', targetKey: 'localConfig' }
        };

        for (const [oldKey, config] of Object.entries(keysConfig)) {
            const raw = localStorage.getItem(oldKey);
            if (raw === null || raw === undefined) continue;

            let localValue;
            try {
                localValue = JSON.parse(raw);
            } catch (e) {
                console.warn(`[BiliCleaner] 解析 localStorage.${oldKey} 失败，跳过迁移`, e);
                continue;
            }

            const targetKey = config.targetKey;
            const existing = storage.get(targetKey, null);
            let merged;

            if (existing === null) {
                merged = localValue;
            } else {
                switch (config.strategy) {
                    case 'union':
                        if (Array.isArray(existing) && Array.isArray(localValue)) {
                            merged = [...new Set([...existing, ...localValue])];
                        } else {
                            merged = existing;
                        }
                        break;
                    case 'keep_newest':
                        if (typeof existing === 'object' && typeof localValue === 'object') {
                            const existingTime = existing.time || 0;
                            const localTime = localValue.time || 0;
                            merged = localTime > existingTime ? localValue : existing;
                        } else {
                            merged = existing;
                        }
                        break;
                    case 'overwrite_if_empty':
                        merged = existing;
                        break;
                    default:
                        merged = existing;
                }
            }

            storage.set(targetKey, merged);
            //localStorage.removeItem(oldKey);
            console.log(`[BiliCleaner] ✅ 已迁移并合并 localStorage.${oldKey} -> GM.${targetKey}`);
        }
    }

    //let stored = JSON.parse(localStorage.getItem('biliCleanerSettings')) || {};
    userSettings = synchronizeSettings(defaultSettings, storage.get('biliCleanerSettings', {}));

    function saveSettings() {
        //localStorage.setItem('biliCleanerSettings', JSON.stringify(userSettings));
        storage.set('biliCleanerSettings', userSettings);
    }

    const defaultConfig = {
        keywordStr: `淘宝|京东|天猫|美团|外卖|补贴|密令|折扣|福利|专属|下单|运(费?)险|[领惠叠]券|[低特好底保降差性]价`,
        biliAdLinks: ['taobao.com', 'tb.cn', 'jd.com', 'pinduodilo.com','zhuanzhuan.com', 'mall.bilibili.com', 'gaoneng.bilibili.com'],
        time: 0
    };

    async function fetchConfigFromGit() {
        let lastError = null;
        const gitMirror = [
            'https://cdn.jsdelivr.net/gh/chemhunter/biliadskip@main/biliadwordslinks.json', //https://purge.jsdelivr.net/link 刷新缓存
            'https://raw.githubusercontent.com/chemhunter/biliadskip/main/biliadwordslinks.json',
        ];

        for (const source of gitMirror) {
            const url = `${source}?t=${Date.now()}`;
            try {
                const response = await fetch(url);
                if (!response.ok) {throw new Error(`HTTP错误! 状态码: ${response.status}`)};
                const text = await response.text();
                try {
                    const configData = JSON.parse(text);
                    log(`✅ 从git镜像: ${source} 获取到广告基础配置`);
                    return configData;
                } catch (parseError) { throw new Error(`JSON解析失败: ${parseError.message}`); }
            } catch (error) { lastError = error; continue;}
        }

        throw new Error(`所有镜像源均无法访问: ${lastError?.message || '未知错误'}`);
    }

    async function getConfigWithFallback(maxRetries = 2) {
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                const res = await fetchConfigFromGit();
                return res;
            } catch (error) {
                console.error(`尝试 ${attempt} 失败:`, error.message);
                if (attempt === maxRetries) {
                    console.warn('⚠️ 所有尝试均失败，使用默认配置');
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 500 * attempt));
            }
        }
        return;
    }

    async function getAdWordsConfig() {
        try {
            //const localConfigStr = localStorage.getItem("localConfig");
            //const localConfig = localConfigStr ? JSON.parse(localConfigStr) : null;
            const localConfig = storage.get('localConfig', null);
            const lastUpdateTime = localConfig && localConfig.time || 0;
            if (Date.now() - lastUpdateTime >= 24 * 3600 * 1000) {
                const res = await getConfigWithFallback();
                if (res) {
                    log(`⚙️ 配置信息:`, res);
                    biliAdWordsConfig = {
                        ...res,
                        keywordStr: Object.values(res.keywordStr).join('|'),
                        time: Date.now()
                    };
                    localStorage.setItem("localConfig", JSON.stringify(biliAdWordsConfig));
                    storage.set('localConfig', biliAdWordsConfig);
                }
            } else {
                log(`读取本地广告词缓存`);
                biliAdWordsConfig = {...localConfig};
                if (!biliAdWordsConfig.time) {
                    biliAdWordsConfig = defaultConfig;
                }
            }
        } catch (error) {
            console.error("获取广告词配置失败:", error);
        }
        keywordRegex = new RegExp(biliAdWordsConfig.keywordStr.replace(/\s+/g, ''), 'i');
        keywordRegexGlobal = new RegExp(biliAdWordsConfig.keywordStr.replace(/\s+/g, ''), 'gi');
    }

    function log(...args) {
        console.log('[BiliCleaner] ', ...args);
    }

    function hideItem(element) {
        if (element && element.style.display !== 'none') {
            element.style.display = 'none';
        }
    }

    function showMessage(msg) {
        messageDiv.textContent = msg;
        messageDiv.style.display = 'block';
        setTimeout(() => {
            messageDiv.style.display = 'none';
        }, 3000);
    }

    function hideUnwantedElements() {
        const rules = {
            // 1. 顶部导航栏 (Global -> Nav)
            nav: [
                'li.v-popover-wrap.left-loc-entry', // 左侧定位/广告
                'ul.left-entry > li.v-popover-wrap:last-child', // 下载客户端
                'ul.right-entry > .vip-wrap', // 大会员
                ".bili-dyn-version-control__reminding", // 动态页新版提醒
            ],
            // 2. 侧边栏 (Global -> Sidebar)
            sidebar: [
                ".video-page-game-card-small", // 视频页：右侧游戏卡片
                '.video-page-special-card-small', // 视频页：右侧特殊卡片
                '.slide-ad-exp', // 视频页：右侧广告块
                //'.video-share-wrap', // 视频页：分享按钮(可选)
                '.video-card-ad-small', // 视频页：弹幕列表下小广告
                'bili-dyn-home--member .right', // 动态页：右侧个人信息/公告
                //'.bili-dyn-banner',
                'aside.right > section > .bili-dyn-banner',// 动态页：右侧公告
                '.bili-dyn-search-trendings', // 动态页：右侧热搜
            ],
            // 3. 评论区横幅 (Comment -> Banner)
            commentBanner: [
                '.ad-report.strip-ad', // 视频下方广告上报条
                '.activity-m-v1', // 评论区上方活动推广
                '.reply-notice', // 动态评论区提醒条
                '.w-100.over-hidden.p-relative.flip-view', // 直播间下方广告横条
            ],
            // 4.1 直播间礼物栏 (Live -> GiftBar)
            liveGiftBar: [
                'gift-control-vm', // 下方送礼栏
                '.gift-control-section', //
                '.gift-menu-root', // 礼物列表
            ],
            // 4.2 直播间聊天栏送礼物提示 (Live -> GiftTip)
            liveGiftTip: [
                '.live-room-app .app-body .aside-area .chat-history-panel .chat-history-list .chat-items .gift-item', // 聊天栏礼物消息 .chat-item
                '.border-box.convention-msg.chat-item', //直播间上方红字系统防骗提醒
            ],
            // 5. 直播间推荐 (Live -> Recommend)
            liveRecommend: [
                '.room-info-ctnr', // 下方推荐直播 4x2
            ],
            // 6. 直播间榜单 (Live -> Rank)
            liveRank: [
                'rank-list-ctnr-box .tab-content.ts-dot-2', // 右上角/上方榜单内容
                // "rank-list-vm", // (原代码注释掉的，如需开启可解注)
                // ".rank-list-section",
            ],
        };

        const { hostname, pathname } = location;
        const isVideoPage = pathname.startsWith('/video/');
        const isDynamicPage = hostname === 't.bilibili.com' || pathname.startsWith('/opus/');
        const isLivePage = hostname === 'live.bilibili.com' || pathname.startsWith('/live/');

        let selectorsToApply = [];

        // --- 应用逻辑 ---

        // 全局开关检查
        if (userSettings.global.enable) {
            // 导航栏
            if (userSettings.global.sub.nav.enable) {
                selectorsToApply.push(...rules.nav);
            }
            // 侧边栏 (视频页 或 动态页热搜)
            if (userSettings.global.sub.sidebar.enable) {
                if (isVideoPage || isDynamicPage) {
                    selectorsToApply.push(...rules.sidebar);
                }
            }
        }

        // 评论区开关检查
        if (userSettings.comment.enable) {
            if (userSettings.comment.sub.banner.enable) {
                selectorsToApply.push(...rules.commentBanner);
            }
        }

        // 直播间开关检查
        if (isLivePage && userSettings.live.enable) {
            initLiveCleaner();
            if (userSettings.live.sub.giftBar.enable) selectorsToApply.push(...rules.liveGiftBar);
            if (userSettings.live.sub.giftTip.enable) selectorsToApply.push(...rules.liveGiftTip);
            if (userSettings.live.sub.recommend.enable) selectorsToApply.push(...rules.liveRecommend);
            if (userSettings.live.sub.rank.enable) {
                selectorsToApply.push(...rules.liveRank);
                // 直播间榜单高度调整逻辑
                const parentElement = document.getElementById('rank-list-vm');
                const childElement = document.getElementById('rank-list-ctnr-box');
                // const scrollbarHeight = document.getElementById('.ps__scrollbar-y-rail');
                // if ( scrollbarHeight ) scrollbarHeight.style.height = '432px';

                if (parentElement && childElement) {
                    let height = parseFloat(window.getComputedStyle(childElement).height);
                    height = !parentElement.dataset.heightModified ? height/3 - 1 : height;
                    parentElement.style.height = `${height}px`;
                    childElement.style.height = `${height}px`;
                    parentElement.dataset.heightModified = 'true';
                }
            }
        }

        // 执行隐藏
        for (const selector of selectorsToApply) {
            const element = document.querySelector(selector);
            if (element) {
                hideItem(element);
            }
        }
    }

    function initLiveCleaner() {
        if (userSettings.live.sub.giftTip.enable) {
            observeLiveGiftTips();
        }
    }

    function stopLiveCleaner() {
        if (liveGiftObserver) {
            liveGiftObserver.disconnect();
            liveGiftObserver = null;
        }
    }

    function observeLiveGiftTips() {
        if (liveGiftObserver) return;
        const container = document.querySelector('.live-room-app .app-body .aside-area .chat-items');
        if (!container) return;
        // 先清理已有礼物消息
        container.querySelectorAll('.chat-item.gift-item').forEach(hideItem);
        liveGiftObserver = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeType !== 1) return;
                    if (node.classList.contains('gift-item')) {
                        hideItem(node);
                    }
                });
            }
        });
        liveGiftObserver.observe(container, { childList: true });
    }

    // 检查评论区
    function checkCommentTopAdsOld() {
        const commentAds = document.querySelectorAll('.dynamic-card-comment .comment-list.has-limit .list-item.reply-wrap.is-top');
        commentAds.forEach(comment => {
            const links = comment.querySelectorAll('a');
            links.forEach(link => {
                const href = link.getAttribute('href');
                if (href && biliAdWordsConfig.biliAdLinks.some(blocked => href.includes(blocked))) {
                    hideItem(comment);
                    log('评论区置顶广告+1(链接)')
                    return true;
                }
            });
        });
        return false;
    }

    // 新版本动态 commentapp or  bili-dyn-comment; 旧版本动态 dynamic-card-comment
    function checkCommentsForAds() {
        // --- 对应 adBlock 开关 ---
        if (!userSettings.comment.enable || !userSettings.comment.sub.adBlock.enable) return false;

        const dynCommentOldVersion = document.querySelector('.dynamic-card-comment');
        if (dynCommentOldVersion) {
            const result = checkCommentTopAdsOld();
            if (result) {
                hiddenAdCount++;
            }
            return result;
        }

        const commentsContainer = document.querySelector('#commentapp > bili-comments') || document.querySelector('.bili-dyn-comment > bili-comments');
        if (commentsContainer && commentsContainer.shadowRoot) {

            const headerElement = commentsContainer.shadowRoot.querySelector("#header > bili-comments-header-renderer");
            if (headerElement && headerElement.shadowRoot) {
                const noticeElement = headerElement.shadowRoot.querySelector("#notice > bili-comments-notice");
                if (noticeElement && noticeElement.shadowRoot) {
                    const closeElement = noticeElement.shadowRoot.querySelector("#close");
                    if (closeElement) {
                        log("评论区横条，自动关闭");
                        closeElement.click();
                    }
                }
            }

            const thread = commentsContainer.shadowRoot.querySelector('bili-comment-thread-renderer');
            if (thread && window.getComputedStyle(thread).display !== 'none' && thread.shadowRoot) {
                const commentRenderer = thread.shadowRoot.querySelector('#comment');
                if (commentRenderer && commentRenderer.shadowRoot) {
                    const richText = commentRenderer.shadowRoot.querySelector('#content > bili-rich-text');
                    if (richText && richText.shadowRoot) {
                        const contentsElement = richText.shadowRoot.querySelector('#contents');
                        if (contentsElement) {
                            let foundAd;
                            const links = contentsElement.querySelectorAll('a');
                            links.forEach(link => {
                                const href = link.getAttribute('href');
                                if (href && biliAdWordsConfig.biliAdLinks.some(blocked => href.includes(blocked))) {
                                    foundAd = true;
                                }
                            });

                            if (!foundAd) {
                                const commentText = contentsElement.textContent.trim();
                                const matchedKeywords = findAdwords(commentText);
                                if (matchedKeywords.length >=2) {
                                    foundAd = true;
                                    log('广告评论：', commentText.slice(0, 60));
                                    log('匹配关键词 >=2：', matchedKeywords)
                                }
                            }

                            if (foundAd) {
                                hideItem(thread);
                                hiddenAdCount++;
                                log('评论区置顶广告 +1')
                                const isVideoPage = window.location.pathname.startsWith('/video/');
                                if (isVideoPage) {
                                    window.MyObserver.disconnect();
                                }
                                let message = `隐藏广告 x ${hiddenAdCount}`;
                                showMessage(message);
                                return true;
                            }
                        }
                    }
                }
            }
        }
        return false;
    }

    function findAdwords(text) {
        const notAd = ['评论','评论区','产品'];
        const matches = text.match(keywordRegexGlobal);
        if (!matches) return [];
        return matches.filter(match => !notAd.includes(match));
    }

    function processFeedCards() {
        const adSpans = document.querySelectorAll('span.bili-video-card__stats--text');
        adSpans.forEach(span => {
            if (span.textContent.trim() === '广告') {
                const targetCard = span.closest('.bili-feed-card') || span.closest('.feed-card');
                if (targetCard) {
                    hideItem(targetCard);
                }
            }
        });

        const allFeedCards = document.querySelectorAll('.feed-card');
        allFeedCards.forEach(card => {
            const hasVideoWrap = card.querySelector('.bili-video-card__wrap');
            if (!hasVideoWrap) {
                hideItem(card);
                return;
            }
        });
    }

    function logCurrentActiveUp() {
        if (window.location.hostname === 't.bilibili.com') {
            const upListContainer = document.querySelector('.bili-dyn-up-list__window');
            if (!upListContainer) {
                return;
            }

            const activeUpElement = document.querySelector('.bili-dyn-up-list__item.active .bili-dyn-up-list__item__name');
            let currentActiveUpName = null;

            if (activeUpElement) {
                currentActiveUpName = activeUpElement.textContent.trim();
            } else {
                // 检查是否是“全部动态”被激活
                const allDynamicActive = document.querySelector('.bili-dyn-up-list__item.active .bili-dyn-up-list__item__face.all');
                if (allDynamicActive) {
                    currentActiveUpName = '全部动态';
                }
            }

            // 只有的当前激活的UP主与上次不同时才输出日志
            if (currentActiveUpName && currentActiveUpName !== lastActiveUpName) {
                const inWhiteList = whiteList.includes(currentActiveUpName)? " (白名单)" : '';
                console.log(
                    `[BiliCleaner] UP: %c${currentActiveUpName}${inWhiteList}`,
                    'background: #009688; color: #fff; padding: 2px 5px; border-radius: 2px; font-weight: bold;'
                );
                lastActiveUpName = currentActiveUpName;
            } else if (!currentActiveUpName && lastActiveUpName !== null) {
                lastActiveUpName = null;
            }
        } else {
            if (lastActiveUpName !== null) {
                lastActiveUpName = null;
            }
        }
    }

    function checkForContentToHide() {
        let hiddenChargeCount = 0;
        let hiddenAdCount = 0;
        const hostname = window.location.hostname;
        const pathname = window.location.pathname;

        // 0. 执行CSS清理
        hideUnwantedElements();

        //B站首页
        if (hostname === 'www.bilibili.com' && !pathname.startsWith('/video/')) {
            if (userSettings.global.enable) {
                // ---首页Feed流卡片 ---
                if (userSettings.global.sub.feed.enable) {
                    processFeedCards();
                    document.querySelectorAll('.floor-single-card').forEach(card => hideItem(card));
                    // 隐藏无视频包裹的卡片
                    document.querySelectorAll('.feed-card').forEach(card => {
                        if (!card.querySelector('.bili-video-card__wrap')) hideItem(card);
                    });
                }

                // --- 首页大屏轮播 ---
                if (userSettings.global.sub.swipe.enable) {
                    const targetElement = document.querySelector('.recommended-swipe');
                    hideItem(targetElement);
                }
            }

            //动态和个人空间页面
        } else if (['t.bilibili.com', 'space.bilibili.com'].includes(hostname)) {
            if (hostname === 't.bilibili.com') {
                logCurrentActiveUp();
                // 宽屏美化
                if (userSettings.dynamic.enable && userSettings.dynamic.sub.widen.enable) {
                    if (!setMainWidth) {
                        const dynMain = document.querySelector('.bili-dyn-home--member > main')
                        if (dynMain) {
                            const currentWidth = parseInt(getComputedStyle(dynMain).width, 10);
                            dynMain.style.width = (currentWidth + 260) + 'px';
                            setMainWidth = true;
                        }
                    }
                    const contentDiv = document.querySelector("#app > div.content");
                    if (contentDiv && contentDiv.style.width !== '900px') {
                        contentDiv.style.width = '900px';
                    }
                }
            }

            checkCommentsForAds();

            // --- 动态过滤逻辑 ---
            if (userSettings.dynamic.enable) {
                const items = document.querySelectorAll('.bili-dyn-list__item');
                items.forEach(item => {
                    if (window.getComputedStyle(item).display !== 'none') {
                        const titleElement = item.querySelector('.bili-dyn-title');
                        if (titleElement && whiteList.includes(titleElement.textContent.trim())) return;

                        function isAdItem(item) { return item.querySelector('.bili-dyn-card-goods, .dyn-goods, bili-dyn-card-goods, dyn-goods'); }

                        function isChargeItem(item) {
                            if (item.querySelector('.dyn-blocked-mask, .bili-dyn-upower-common, .bili-dyn-upower-lottery, .dyn-icon-badge__renderimg.bili-dyn-item__iconbadge, .bili-dyn-card-common')) return true;
                            const badge = item.querySelector('.bili-dyn-card-video__badge');
                            if (badge && /专属|抢先看/.test(badge.textContent)) return true;
                            const lotteryTitle = item.querySelector('.dyn-upower-lottery__title');
                            if (lotteryTitle && lotteryTitle.textContent.includes('专属')) return true;
                            return false;
                        }

                        // 商品过滤
                        if (userSettings.dynamic.sub.goods.enable) {
                            if (isAdItem(item)) {
                                hideItem(item);
                                log('广告卡片 +1');
                                hiddenAdCount++;
                                return;
                            }
                            // 过期预约也归类在此
                            const disabled = item.querySelector('.uncheck.disabled');
                            if (disabled) {
                                hideItem(item);
                                return;
                            }
                        }

                        // --- 充电/专属过滤开关 ---
                        if (userSettings.dynamic.sub.charge.enable) {
                            if (isChargeItem(item)) {
                                const titleElement = item.querySelector('.bili-dyn-card-video__title');
                                if (titleElement) {
                                    const videoTitle = titleElement.textContent.trim();
                                    log(`充电专属 +1: \n ----->"${videoTitle}"`);
                                } else {
                                    log(`充电专属 +1`);
                                }
                                hideItem(item);
                                hiddenChargeCount++;
                                return;
                            }
                        }

                        // 辅助函数：在指定容器中检查广告并隐藏
                        function checkAndHideAd(container, type) {
                            let richtext = container.querySelector('.bili-rich-text .bili-rich-text__content')?.textContent?.trim();
                            if ( !richtext ) {
                                richtext = container.querySelector('.dyn-card-opus')?.textContent?.trim();
                            }
                            if (richtext) {
                                const isLotteryCard = (item) => {
                                    const text = item.innerText || '';
                                    if (text.includes('抽奖')) return true;
                                    return false;
                                };
                                if (isLotteryCard(container)) return false;

                                const matchedKeywords = findAdwords(richtext);
                                if (matchedKeywords.length >=2) {
                                    log(`广告关键词 +1(${type}) \n ----> ${richtext.slice(0, 60)}`);
                                    log('匹配词 >=2： ', matchedKeywords)
                                    hideItem(item);
                                    hiddenAdCount++;
                                    return true;
                                }
                            }
                            return false;
                        }

                        // --- 【修改】关键词/链接过滤开关 ---
                        if (userSettings.dynamic.sub.goods.enable) {
                            //查找动态主体内容 bili-dyn-content
                            const bili_dyn_content = item.querySelector('.bili-dyn-content');
                            // 注意：这里需要加个判空，防止报错
                            if (bili_dyn_content) {
                                const origContent = bili_dyn_content.querySelector('.bili-dyn-content__orig.reference');
                                const orig = origContent ? '转发' : '原创'
                                if(checkAndHideAd(bili_dyn_content, orig)) return; // 如果隐藏了，直接返回
                            }

                            const spans = item.querySelectorAll('span');
                            spans.forEach(span => {
                                const dataUrl = span.getAttribute('data-url');
                                if (dataUrl && biliAdWordsConfig.biliAdLinks.some(blocked => dataUrl.includes(blocked))) {
                                    hideItem(item);
                                    log('广告链接 +1')
                                    hiddenAdCount++;
                                } else if (span.textContent.includes('专属')) {
                                    hideItem(item);
                                    log('充电专属 +1')
                                    hiddenChargeCount++;
                                    return;
                                }
                            });
                        }
                    }
                });
            }
            //视频页面
        } else if (pathname.startsWith('/video/BV')) {
            // --- 【修改】评论区开关 ---
            if (userSettings.comment.enable) {
                if (!checkCommentsForAds()) {
                    setTimeout(() => {
                        checkCommentsForAds();
                    }, 2000);
                }
            }
        }

        let message = '';
        if (hiddenChargeCount > 0) {
            message += `隐藏充电 x ${hiddenChargeCount} `;
        }
        if (hiddenAdCount > 0) {
            message += `隐藏广告 x ${hiddenAdCount} `;
        }
        if (message) {
            showMessage(message.trim());
        } else {
            logCurrentActiveUp();
        }
    }

    // 元素是否可见
    function isVisible(el) {
        return el && el.offsetParent !== null;
    }

    /** 过滤单个动态卡片链接 */
    function filterSingleDynamicLink(linkElement) {
        //if (!isVisible(linkElement)) return;
        const title = linkElement.getAttribute('title') || '';
        const tagSpan = linkElement.querySelector('.all-in-one-article-title > .article-tag');
        const isArticle = tagSpan && tagSpan.textContent.trim() === '专栏';
        if (!isArticle) return;
        log(title);
        if (keywordRegex.test(title)) {
            const authorElement = linkElement.querySelector('.user-name a[title]');
            const author = authorElement ? authorElement.getAttribute('title') : '未知作者';
            log(`🚫 [动态弹窗] 广告卡片: 「${author}」- ${title.slice(0, 20)}...`);
            linkElement.style.display = 'none';
        }
    }

    /* 停用代码，通过更精确的网络api拦截动态按钮广告, "type":64
    function watchDynamicAllPanel() {
        // --- 对应 popup 开关 ---
        if (!userSettings.dynamic.enable || !userSettings.dynamic.sub.popup.enable) return;
        // ...
    }
    */

    function debounce(func, wait) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    function initObserver() {
        const mainObserver = new MutationObserver(debounce(checkForContentToHide, 300));
        mainObserver.observe(document.body,{ childList: true, subtree: true, });
        return mainObserver;
    }

    function restartMainObserver() {
        log('页面内容更新，重启观察器');
        if (window.MyObserver) {
            window.MyObserver.disconnect();
        }
        const mainObserver = initObserver();
        window.MyObserver = mainObserver;
    }

    // 监听 commentapp 元素的变化
    function initCommentAppObserver() {
        const commentApp = document.querySelector('#commentapp');
        if (commentApp) {
            commentAppObserver = new MutationObserver(restartMainObserver);
            commentAppObserver.observe(commentApp, { childList: true, subtree: true, attributes: true, attributeFilter: ['class']});
            log('启动观察commentapp');
        }
    }


    /** 显示白名单管理菜单*/
    async function whiteListMenu() {

        // 添加到白名单
        function addToWhiteList(upId) {
            if (!whiteList.includes(upId)) {
                whiteList.push(upId);
                //localStorage.setItem('biliUpWhiteList', JSON.stringify(whiteList));
                storage.set('biliUpWhiteList', whiteList);
                updateWhiteListDisplay();
            } else {
                alert(`${upId} 已在白名单中`);
            }
            syncConfigToPage();
        }

        // 从白名单中移除
        function removeFromWhiteList(upId) {
            const index = whiteList.indexOf(upId);
            if (index !== -1) {
                whiteList.splice(index, 1);
                //localStorage.setItem('biliUpWhiteList', JSON.stringify(whiteList));
                storage.set('biliUpWhiteList', whiteList);
                updateWhiteListDisplay();
            } else {
                alert(`${upId} 不在白名单中`);
            }
            syncConfigToPage();
        }

        // 更新白名单显示
        function updateWhiteListDisplay() {
            const listDisplay = document.getElementById('whiteListDisplay');
            if (listDisplay) {
                listDisplay.textContent = whiteList.join(', ') || '白名单为空';
            }

            const currentUserRow = document.getElementById('bili-current-up-display');
            const upInfo = getUpInfo();
            if (currentUserRow) {
                if (upInfo && upInfo.name) {
                    currentUserRow.innerHTML = `当前页面UP主: <b style="color: #00a1d6;">${upInfo.name}</b>`;
                } else {
                    currentUserRow.innerHTML = '';
                }
            }

            // 2. 【核心新增】更新“添加/移除当前页UP”按钮的状态
            const currentUpBtn = document.getElementById('bili-add-current-up-btn');
            if (currentUpBtn) {
                const upInfo = getUpInfo();
                if (upInfo && upInfo.name) {
                    currentUpBtn.style.display = '';
                    if (whiteList.includes(upInfo.name)) {
                        currentUpBtn.textContent = `移除当前UP`;
                        currentUpBtn.style.backgroundColor = '#e74c3c'; // 红色
                    } else {
                        currentUpBtn.textContent = `添加当前UP`;
                        currentUpBtn.style.backgroundColor = '#2eac31'; // 绿色
                    }
                } else {
                    currentUpBtn.style.display = 'none';
                }
            }
        }

        function getUpInfo() {
            const isSpacePage = window.location.href.match(/space.bilibili.com\/(\d+)/);
            const isVideoPage = window.location.href.includes('/video/BV');
            const container = isSpacePage ? document.querySelector('.upinfo__main') : document.querySelector('.up-panel-container');

            if (isVideoPage) {
                // 单个UP主的情况
                const singleUp = container.querySelector('.up-detail .up-detail-top .up-name');
                if (singleUp) {
                    const clone = singleUp.cloneNode(true);
                    clone.querySelectorAll('span').forEach(span => span.remove());
                    const name = clone.textContent.trim();

                    const href = singleUp.getAttribute('href');
                    const idMatch = href.match(/space\.bilibili\.com\/(\d+)/);
                    const id = idMatch ? idMatch[1] : null;

                    return { name, id};

                } else {
                    //多个UP的情况
                    const allMemberCards = container.querySelectorAll('.membersinfo-upcard');
                    const firstUpCard = allMemberCards[0];
                    if (firstUpCard) {
                        const nameElement = firstUpCard.querySelector('.staff-name');
                        const name = nameElement ? nameElement.textContent.trim() : null;
                        const idElement = firstUpCard.querySelector('a[href*="space.bilibili.com"]');
                        const href = idElement ? idElement.getAttribute('href') : null;
                        const id = href ? href.match(/\/\/space\.bilibili\.com\/(\d+)/)?.[1] : null;
                        return { name, id};
                    }
                }
            }
            return null;
        }

        const UpWhiteListContainer = document.createElement('div');
        UpWhiteListContainer.id = 'UpWhiteListContainer';
        UpWhiteListContainer.style.cssText = `
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 500px;
        padding: 20px;
        background: #fff;
        border: 1px solid #ccc;
        border-radius: 10px;
        z-index: 10000;
        font-size: 16px;
        box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
    `;

        const Title = document.createElement('h3');
        Title.textContent = `手动管理白名单（跳过检测）`;
        Title.style.cssText = 'text-align: center; margin-bottom: 20px; font-weight: bold; cursor: move; user-select: none;';
        UpWhiteListContainer.appendChild(Title);

        const toggleUpRow = document.createElement('div');
        toggleUpRow.style.cssText = `display: flex; align-items: center; margin-bottom: 10px; gap: 10px;`;

        const toggleUpLabel = document.createElement('label');
        toggleUpLabel.textContent = '添加/移除UP主:';
        toggleUpLabel.style.cssText = `flex-shrink: 0;`;

        // 为“执行”按钮绑定智能的切换逻辑
        const handleToggle = () => {
            const upName = toggleUpInput.value.trim();
            if (!upName) return;
            if (whiteList.includes(upName)) {
                removeFromWhiteList(upName);
            } else {
                addToWhiteList(upName);
            }
            toggleUpInput.value = '';
        };

        const toggleUpInput = document.createElement('input');
        toggleUpInput.type = 'text';
        toggleUpInput.id = 'toggleUpInput';
        toggleUpInput.placeholder = '输入UP主昵称';
        toggleUpInput.style.cssText = 'flex-grow: 1; min-width: 200; max-width: 240px; border: 1px solid #ccc;';
        toggleUpInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') handleToggle();
        });

        const toggleButton = createButton('执行', handleToggle);
        toggleButton.style.minWidth = '80px';

        toggleUpRow.appendChild(toggleUpLabel);
        toggleUpRow.appendChild(toggleUpInput);
        toggleUpRow.appendChild(toggleButton);
        UpWhiteListContainer.appendChild(toggleUpRow);

        // 白名单列表显示区域
        const listDiv = document.createElement('div');
        listDiv.id = 'whiteListDisplay';
        listDiv.style.cssText = `
        text-align: left;
        color: #30b688;
        margin: 20px 0;
        padding: 5px;
        border: 1px dashed #ccc;
        border-radius: 5px;
        font-size: 14px;
        word-break: break-word;
        max-height: 150px;
        overflow-y: auto;`;
        listDiv.textContent = whiteList.join(', ') || '白名单为空';
        UpWhiteListContainer.appendChild(listDiv);

        const currentUpInfo = getUpInfo();
        if (currentUpInfo && currentUpInfo.name) {
            const currentUserRow = document.createElement('div');
            currentUserRow.id = 'bili-current-up-display';
            currentUserRow.style.cssText = `text-align: center; font-size: 16px; color: #555; margin: 5px 0; padding: 5px;`;
            UpWhiteListContainer.appendChild(currentUserRow);
        }

        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = 'display: flex; justify-content: center; margin: 10px 0; gap: 10px';

        function createButton(text, onClick) {
            const button = document.createElement('button');
            button.textContent = text;
            button.style.cssText = `padding: 3px 3px; border: 1px solid #ccc; background: #f0f0f0; border-radius: 4px; cursor: pointer; font-size: 14px;`;
            if (onClick) button.onclick = onClick;
            return button;
        }

        const finishButton = createButton('关闭界面', () => {
            document.body.removeChild(UpWhiteListContainer);
        })

        if (currentUpInfo && currentUpInfo.name) {
            const upName = currentUpInfo.name;
            const toggleCurrentUpButton = document.createElement('button');
            toggleCurrentUpButton.id = 'bili-add-current-up-btn';
            toggleCurrentUpButton.style.cssText = `color: white; padding: 4px 5px; margin: 0 5px; border: none; border-radius: 4px;`;
            toggleCurrentUpButton.addEventListener('click', () => {
                if (whiteList.includes(upName)) {
                    removeFromWhiteList(upName);
                } else {
                    addToWhiteList(upName);
                }
            });
            buttonContainer.appendChild(toggleCurrentUpButton);
        }

        buttonContainer.appendChild(finishButton);
        UpWhiteListContainer.appendChild(buttonContainer);
        document.body.appendChild(UpWhiteListContainer);

        updateWhiteListDisplay();
    }

    function prepareForWork() {
        // 迁移旧localStorage数据（合并+去重）
        migrateFromLocalStorage();

        // 初始化白名单
        //whiteList = JSON.parse(localStorage.getItem('biliUpWhiteList')) || [];
        whiteList = storage.get('biliUpWhiteList', []);

        // --- 注册设置菜单 ---
        GM_registerMenuCommand("⚙️ 功能开关", openSettingsMenu);

        // 注册菜单命令
        GM_registerMenuCommand("🛡️ UP白名单", whiteListMenu);

        //创建提醒元素
        messageDiv = document.createElement('div');
        Object.assign(messageDiv.style, {
            position: 'fixed',
            top: '10px',
            right: '10px',
            padding: '10px',
            backgroundColor: 'rgba(0, 0, 0, 0.7)',
            color: 'white',
            borderRadius: '5px',
            zIndex: '9999',
            display: 'none'
        });

        if (document.body) {
            document.body.appendChild(messageDiv);
        } else {
            document.addEventListener('DOMContentLoaded', () => {
                document.body.appendChild(messageDiv);
            });
        }

        lastPathname = window.location.pathname;
        syncConfigToPage();
    }

    // --- 【新增】2. 设置菜单 UI ---
    function openSettingsMenu() {
        // 创建背景遮罩
        const backdrop = document.createElement('div');
        backdrop.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.4); z-index: 10000;';

        // 创建菜单容器
        const container = document.createElement('div');
        container.id = 'BiliCleanerSettings';
        container.style.cssText = 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 500px; padding: 20px; background: #fff; border-radius: 10px; z-index: 10001; font-size: 15px; box-shadow: 0 4px 12px rgba(0,0,0,0.2); max-height: 80vh; overflow-y: auto;';

        // 标题
        const title = document.createElement('h3');
        title.textContent = 'BiliCleaner 功能开关';
        title.style.cssText = 'text-align: center; margin-bottom: 15px; font-weight: bold; border-bottom: 1px solid #eee; padding-bottom: 10px;';
        container.appendChild(title);

        const content = document.createElement('div');

        // 遍历生成开关
        for (const [key, group] of Object.entries(userSettings)) {
            const groupDiv = document.createElement('div');
            groupDiv.style.cssText = "margin-bottom: 10px; padding: 10px; background: #f9f9f9; border-radius: 6px;";

            // 父级开关行
            const header = document.createElement('div');
            header.style.cssText = "display: flex; align-items: center; font-weight: bold; margin-bottom: 5px;";

            const groupCb = document.createElement('input');
            groupCb.type = 'checkbox';
            groupCb.checked = group.enable;
            groupCb.style.marginRight = '8px';

            const groupLabel = document.createElement('span');
            groupLabel.textContent = group.label;

            header.appendChild(groupCb);
            header.appendChild(groupLabel);
            groupDiv.appendChild(header);

            const subContainer = document.createElement('div');
            subContainer.style.cssText = `margin-left: 24px; display: ${group.enable ? 'block' : 'none'};`;

            groupCb.onchange = (e) => {
                group.enable = e.target.checked;
                subContainer.style.display = group.enable ? 'block' : 'none';
                saveSettings();
            };

            for (const [subKey, subItem] of Object.entries(group.sub)) {
                const subRow = document.createElement('div');
                subRow.style.margin = "5px 0";

                const subCb = document.createElement('input');
                subCb.type = 'checkbox';
                subCb.checked = subItem.enable;
                subCb.style.marginRight = '8px';

                const subLabel = document.createElement('label');
                subLabel.textContent = subItem.label;
                subLabel.style.cursor = 'pointer';
                subLabel.onclick = () => subCb.click();

                subCb.onchange = (e) => {
                    subItem.enable = e.target.checked;
                    saveSettings();
                };

                subRow.appendChild(subCb);
                subRow.appendChild(subLabel);
                subContainer.appendChild(subRow);
            }
            groupDiv.appendChild(subContainer);
            content.appendChild(groupDiv);
        }
        container.appendChild(content);

        // 关闭按钮
        const closeBtn = document.createElement('button');
        closeBtn.textContent = "保存并生效";
        closeBtn.style.cssText = `display: block; width: 100%; padding: 10px; background: #00a1d6; color: white; border: none; border-radius: 5px; cursor: pointer; margin-top: 15px;`;

        const closeAction = () => {
            saveSettings();
            document.body.removeChild(backdrop);
            document.body.removeChild(container);
            //checkForContentToHide();
            showMessage("设置已保存");
            reinitializeAllObservers();
            syncConfigToPage();
        };
        closeBtn.onclick = closeAction;
        backdrop.onclick = closeAction;

        container.appendChild(closeBtn);
        document.body.appendChild(backdrop);
        document.body.appendChild(container);
    }

    function reinitializeAllObservers() {
        log('执行观察器初始化...');

        // 1. 断开所有可能存在的旧观察器
        if (window.MyObserver) window.MyObserver.disconnect();
        if (commentAppObserver) commentAppObserver.disconnect();
        if (dynamicPanelObserver) dynamicPanelObserver.disconnect();
        stopLiveCleaner();

        // 2. 重新运行所有初始化逻辑
        window.MyObserver = initObserver();
        initCommentAppObserver();
        checkForContentToHide();
    }

    // 导航观察器 ---
    function setupNavigationObserver() {
        const observer = new MutationObserver(() => {
            const currentPath = window.location.pathname.replace(/\/$/, '');
            const lastPath = lastPathname.replace(/\/$/, '');

            if (!lastPathname || currentPath !== lastPath) {
                if (lastPathname) log(`检测到页面导航: ${lastPathname} -> ${window.location.pathname}`);
                lastPathname = window.location.pathname;
                debounce(reinitializeAllObservers, 1500)();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        log('✅ 主导航观察器已启动');
    }

    function injectBiliInterceptor() {
        const interceptorLogic = `
(function() {
    // 防重复注入

    if (window.__biliInterceptorInjected) return;
    window.__biliInterceptorInjected = true;
    const originalFetch = window.fetch;

    console.log('[BiliCleaner] 🚀 网络拦截器已加载');

    const targetReplyUrl = '/x/v2/reply/wbi/main';
    const targetDynUrl = '/x/polymer/web-dynamic/v1/feed/all';
    const targetNavUrl = '/x/polymer/web-dynamic/v1/feed/nav';
    const targetSpaceUrl = '/x/polymer/web-dynamic/v1/feed/space';

    // 默认配置（所有拦截相关开关默认为 true）
    const DEFAULT_INTERCEPTOR_SETTINGS = {
        dynamic: { enable: true, sub: { goods: { enable: true }, charge: { enable: true }, reverse: { enable: true } } },
        comment: { enable: true, sub: { adBlock: { enable: true } } }
    };

    const defaultConfig = {
        keywordStr: '淘宝|京东|天猫|美团|外卖|补贴|密令|折扣|福利|专属|下单|运(费?)险|[领惠叠]券|[低特好底保降差性]价',
        biliAdLinks: ['taobao.com', 'tb.cn', 'jd.com', 'pinduodilo.com','zhuanzhuan.com', 'mall.bilibili.com', 'gaoneng.bilibili.com'],
        time:0,
    };

    let runtimeSettings = null;
    let runtimeWhiteList = [];
    let runtimeRegex = null;

    const biliAdWordsConfig = JSON.parse(localStorage.getItem("localConfig")) || defaultConfig;
    const keywordRegex = new RegExp(biliAdWordsConfig.keywordStr.replace(/\s+/g, ''), 'i');
    const keywordRegexGlobal = new RegExp(biliAdWordsConfig.keywordStr.replace(/\s+/g, ''), 'gi');

    function refreshRuntimeConfig() {
    try {
        // 从页面全局变量获取配置（由主脚本通过 syncConfigToPage 同步）
        const pageConfig = window.__biliCleanerConfig || {};
        const rawSettings = pageConfig.settings;
        const rawWhiteList = pageConfig.whiteList;
        const keywordPattern = pageConfig.keywords;

        // 处理设置对象（确保结构完整）
        if (rawSettings) {
            // 深拷贝，避免后续修改影响原始对象
            runtimeSettings = JSON.parse(JSON.stringify(rawSettings));
            // 确保必要的子对象存在（防止用户配置结构不完整）
            if (!runtimeSettings.dynamic) runtimeSettings.dynamic = { enable: true, sub: {} };
            if (!runtimeSettings.dynamic.sub) runtimeSettings.dynamic.sub = {};
            if (runtimeSettings.dynamic.sub.goods === undefined) runtimeSettings.dynamic.sub.goods = { enable: true };
            if (runtimeSettings.dynamic.sub.charge === undefined) runtimeSettings.dynamic.sub.charge = { enable: true };
            if (runtimeSettings.dynamic.sub.reverse === undefined) runtimeSettings.dynamic.sub.reverse = { enable: true };
            if (!runtimeSettings.comment) runtimeSettings.comment = { enable: true, sub: {} };
            if (!runtimeSettings.comment.sub) runtimeSettings.comment.sub = {};
            if (runtimeSettings.comment.sub.adBlock === undefined) runtimeSettings.comment.sub.adBlock = { enable: true };
        } else {
            // 无配置时，使用默认配置（所有开关为 true）
            runtimeSettings = JSON.parse(JSON.stringify(DEFAULT_INTERCEPTOR_SETTINGS));
        }

        // 处理白名单
        runtimeWhiteList = Array.isArray(rawWhiteList) ? rawWhiteList : [];

        // 处理关键词正则
        if (keywordPattern && typeof keywordPattern === 'string') {
            const cleaned = keywordPattern.replace(/\s+/g, '');
            runtimeRegex = new RegExp(cleaned, 'gi');
        } else {
            runtimeRegex = null;
        }
    } catch (e) {
        console.error('[BiliCleaner] refreshRuntimeConfig 失败:', e);
        // 降级到默认配置
        runtimeSettings = JSON.parse(JSON.stringify(DEFAULT_INTERCEPTOR_SETTINGS));
        runtimeWhiteList = [];
        runtimeRegex = null;
    }
    }

    // 深度提取动态 item 中的所有文本内容（用于广告关键词匹配）
    function extractAllTextFromItem(item) {
        const textParts = [];
        const modules = item.modules || {};
        const dynamic = modules.module_dynamic || {};

        // 1. 动态描述文本 (desc)
        if (dynamic.desc?.text) {
            textParts.push(dynamic.desc.text);
        }
        if (dynamic.desc?.rich_text_nodes) {
            dynamic.desc.rich_text_nodes.forEach(node => {
                if (node.text) textParts.push(node.text);
            });
        }

        // 2. 主要内容的文本 (major)
        const major = dynamic.major || {};
        if (major.opus) {
            // 专栏/图文
            const opus = major.opus;
            if (opus.title) textParts.push(opus.title);
            if (opus.summary?.text) textParts.push(opus.summary.text);
            if (opus.summary?.rich_text_nodes) {
                opus.summary.rich_text_nodes.forEach(node => {
                    if (node.text) textParts.push(node.text);
                });
            }
        }
        if (major.archive) {
            // 视频
            if (major.archive.title) textParts.push(major.archive.title);
            if (major.archive.desc) textParts.push(major.archive.desc);
        }
        if (major.article) {
            // 旧版文章
            if (major.article.title) textParts.push(major.article.title);
            if (major.article.summary) textParts.push(major.article.summary);
        }

        // 3. 附加信息 (additional) 中的商品名称
        const additional = dynamic.additional;
        if (additional?.goods?.items) {
            additional.goods.items.forEach(good => {
                if (good.name) textParts.push(good.name);
                if (good.brief) textParts.push(good.brief);
            });
        }

        // 4. 原始动态中的原动态（转发内容） - 如果是转发，orig 字段可能存在
        if (item.orig) {
            const origText = extractAllTextFromItem(item.orig);
            if (origText) textParts.push(origText);
        }

        return textParts.filter(t => t && typeof t === 'string').join(',');
    }

    function getMatchedAdKeywords(text) {
        const notAd = ['评论', '评论区', '产品'];
        const matches = text.matchAll(runtimeRegex);
        const keywordSet = new Set();
        for (const match of matches) {
            const word = match[0];
            if (!notAd.includes(word)) {
                keywordSet.add(word);
            }
        }
        return Array.from(keywordSet);
    }

    function filterDynamic(json, settings, whiteList, regex) {
        if (!json?.data?.items || !settings?.dynamic?.enable) return json;
        const originalCount = json.data.items.length;

        // 辅助函数：检查一个动态对象（item 或 orig）是否包含抽奖节点
        function hasLotteryNode(dynamicObj) {
            if (!dynamicObj) return false;
            try {
                const summary = dynamicObj.modules?.module_dynamic?.major?.opus?.summary;
                if (summary && Array.isArray(summary.rich_text_nodes)) {
                    return summary.rich_text_nodes.some(node => node.type === 'RICH_TEXT_NODE_TYPE_LOTTERY');
                }
            } catch (e) {}
            return false;
        }

        // 判断整个动态（含转发）是否为抽奖相关
        function isLotteryDynamic(item) {
            if (hasLotteryNode(item)) return true;
            if (item.orig && hasLotteryNode(item.orig)) return true;
            return false;
        }

        const enableGoods = !(settings.dynamic.sub.goods?.enable === false);
        const enableCharge = !(settings.dynamic.sub.charge?.enable === false);
        const enableReverse = !(settings.dynamic.sub.reverse?.enable === false);

        json.data.items = json.data.items.filter(item => {
            const authorName = item.modules?.module_author?.name || '未知用户';
            if (authorName && whiteList?.includes(authorName)) return true;
            const pubTime = item.modules?.module_author?.pub_time || '';

            //if (item.type === 'DYNAMIC_TYPE_AV') {
            //    console.log('[BiliCleaner] 💹类型放行：', authorName, pubTime, item.type, jump_url);
            //    return true;
            //}

            const jump_url = 'https:' + (item.basic?.jump_url || item.modules?.module_dynamic?.major?.archive?.jump_url || item.orig?.basic?.jump_url)
            if (isLotteryDynamic(item)) {
                console.log('BiliCleaner] 🎁 动态放行-抽奖', authorName, jump_url);
                return true;
            }

            // 1. 结构化拦截：商品、预约、充电专属
            const dyn = item.modules?.module_dynamic;
            const addType = dyn?.additional?.type;

            if (enableGoods) {
                if (addType === "ADDITIONAL_TYPE_GOODS") {
                    console.log('[BiliCleaner] 🚫 网络拦截-商品推广', authorName, pubTime, jump_url);
                    return false;
                }
            }

            if (enableReverse) {
                if (addType === "ADDITIONAL_TYPE_RESERVE") {
                    console.log('[BiliCleaner] 🚫 网络拦截-预约动态', authorName, pubTime, jump_url);
                    return false;
                }
            }

            if (enableCharge) {
                if (item.type === 'DYNAMIC_TYPE_COMMON_SQUARE' ||
                    dyn?.major?.type === "MAJOR_TYPE_BLOCKED" ||
                    item.basic?.is_only_fans ||
                    dyn?.major?.archive?.badge?.text === "充电专属") {
                    const title = dyn?.major?.archive?.title || ''
                    console.log('[BiliCleaner] 🚫 网络拦截-充电专属:', authorName, pubTime, title, jump_url);
                    return false;
                }
            }

            // 2. 文本关键词过滤（仅当商品推广开关启用时）
            if (enableGoods && regex) {
                const allText = extractAllTextFromItem(item);
                if (allText) {
                    const matches = getMatchedAdKeywords(allText);
                    if (matches && matches.length >= 2) {
                        const pubTime = item.modules?.module_author?.pub_time || '';
                        console.log('[BiliCleaner] 🚫 网络拦截-关键词命中:' , authorName , pubTime, '->', allText.slice(0, 80)+ ' ... ', jump_url);
                        console.log('[BiliCleaner] 🎯 匹配关键词：' , matches);
                        return false;
                    }
                }
            }

            return true;
        });

        const blockedCount = originalCount - json.data.items.length;
        if (blockedCount > 0) console.log('[BiliCleaner] 🧹 动态流已净化: 移除 ' + blockedCount + ' 条广告');
        return json;
    }

    function filterReply(json, settings, whiteList, keywordRegex) {
        if (!json?.data || !settings?.comment?.sub?.adBlock?.enable) return json;

        const checkAd = (r, source) => {
            if (!r?.content) return false;
            const u = r.member?.uname || '未知用户';
            if (whiteList.includes(u)) return false;

            if (r.content.jump_url && Object.keys(r.content.jump_url).length > 0) {
                console.log('[BiliCleaner] 🚫 网络拦截-置顶带货(' + source + '):', u);
                return true;
            }

            if (keywordRegex && r.content.message?.match(keywordRegex)) {
                const isReal = r.content.message.match(keywordRegex).some(m => !['评论','评论区','产品'].includes(m));
                if (isReal) {
                    console.log('[BiliCleaner] 🚫 网络拦截-置顶关键词(' + source + '):', u);
                    return true;
                }
            }
            return false;
        };

        // 清洗 data.top.upper
        if (json.data.top?.upper && checkAd(json.data.top.upper, 'upper')) {
            json.data.top.upper = null;
        }

        // 清洗 data.top_replies
        if (Array.isArray(json.data.top_replies)) {
            json.data.top_replies = json.data.top_replies.filter(r => !checkAd(r, 'top_replies'));
        }
        return json;
    }

    function filterNav(json, settings, whiteList, keywordRegex) {
        let items = json?.data?.items ?? json?.items;
        if (!items) return json;

        const goodsEnabled = settings?.dynamic?.sub?.goods?.enable !== false;
        const popupEnabled = settings?.dynamic?.sub?.popup?.enable !== false;
        if (!goodsEnabled || !popupEnabled) {
            console.log('[BiliCleaner] ⏭️ 导航动态过滤跳过: goods=%o, popup=%o', goodsEnabled, popupEnabled);
            return json;
        }

        const originalCount = json.data.items.length;
        json.data.items = json.data.items.filter(item => {
            const authorName = item.author?.name;
            if (authorName && whiteList.includes(authorName)) return true;

            if (item.type === 64) { // 核心：过滤 type === 64 的广告项
                console.log('[BiliCleaner] 🚫 网络拦截-导航动态广告:', authorName, '->', item.title);
                return false;
            }
            return true;
        });
        const blockedCount = originalCount - json.data.items.length;
        if (blockedCount > 0) {
            if (json.data.items.length === 0) {
                json.data.has_more = false;
                json.data.offset = null;
            }
        }
        return json;
    }

    // 3. fetch 拦截逻辑
    window.fetch = async function(...args) {
        const url = (typeof args[0] === 'string') ? args[0] : args[0].url;

        // 刷新配置的条件
        const urlMatched  = url && (url.includes(targetDynUrl) || url.includes(targetSpaceUrl) || url.includes(targetReplyUrl) || url.includes(targetNavUrl))
        if (urlMatched) {
            refreshRuntimeConfig();
        }

        const response = await originalFetch.apply(this, args);
        if (urlMatched) {
            try {
                const clone = response.clone();
                let json = await clone.json();

                if (url.includes(targetDynUrl) || url.includes(targetSpaceUrl)) {
                    json = filterDynamic(json, runtimeSettings, runtimeWhiteList, runtimeRegex);
                } else if (url.includes(targetNavUrl)) {
                    json = filterNav(json, runtimeSettings, runtimeWhiteList, runtimeRegex);
                } else {
                    json = filterReply(json, runtimeSettings, runtimeWhiteList, runtimeRegex);
                }

                return new Response(JSON.stringify(json), {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers
                });
            } catch (e) {
                return response;
            }
        }
        return response;
    };
})();
`;

        const script = document.createElement('script');
        script.textContent = interceptorLogic;
        (document.head || document.documentElement).appendChild(script);
        script.remove();
    }

    function syncConfigToPage() {
        const config = {
            settings: userSettings,
            whiteList: whiteList,
            keywords: biliAdWordsConfig?.keywordStr || null
        };
        const script = document.createElement('script');
        script.textContent = `window.__biliCleanerConfig = ${JSON.stringify(config)};`;
        (document.head || document.documentElement).appendChild(script);
        script.remove();
        log('脚本配置已写入页面全局对象');
    }

    async function initApp() {
        log('脚本加载，初始化');
        await getAdWordsConfig();
        prepareForWork();
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                reinitializeAllObservers();
                setupNavigationObserver();
            });
        } else {
            reinitializeAllObservers();
            setupNavigationObserver();
        }
    }

    injectBiliInterceptor();
    initApp().catch(console.error);
})();
