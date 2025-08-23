// ==UserScript==
// @name         Bilibili-去充电广告
// @namespace    https://greasyfork.org/scripts/511437/
// @description  隐藏B站动态瀑布流中的广告、评论区广告、充电内容以及美化首页
// @version      1.30
// @author       chemhunter
// @match        *://t.bilibili.com/*
// @match        *://space.bilibili.com/*
// @match        *://www.bilibili.com/*
// @connect      www.gitlabip.xyz
// @connect      hub.gitmirror.com
// @connect      raw.githubusercontent.com
// @grant        GM_registerMenuCommand
// @icon         https://i0.hdslb.com/bfs/static/jinkela/long/images/favicon.ico
// @run-at       document-end
// @downloadURL https://update.greasyfork.org/scripts/511437/B%E7%AB%99%E9%9A%90%E8%97%8F%E5%85%85%E7%94%B5%E5%92%8C%E5%B9%BF%E5%91%8A.user.js
// @updateURL https://update.greasyfork.org/scripts/511437/B%E7%AB%99%E9%9A%90%E8%97%8F%E5%85%85%E7%94%B5%E5%92%8C%E5%B9%BF%E5%91%8A.meta.js
// @license      GPL-3.0 License

// ==/UserScript==

(function() {
    'use strict';

    // --- 新增：声明全局变量 ---
    let keywordRegex, biliAdWordsConfig;
    let mainObserver, commentAppObserver, dynamicPanelObserver; // 用于存储观察器实例
    let lastPathname = ''; // 用于追踪URL路径变化
    let hiddenAdCount = 0;

    const defaultConfig = {
        keywordStr: `淘宝|京东|天猫|补贴|折扣|福利|专属|下单|运(费?)险|[领惠叠]券|[低特好底保降差性]价`,
        biliAdLinks: ['taobao.com', 'tb.cn', 'jd.com', 'pinduodilo.com','zhuanzhuan.com', 'mall.bilibili.com', 'gaoneng.bilibili.com'],
        time: 0
    };

    async function fetchConfigFromGit() {
        let lastError = null;
        const gitSource = ['www.gitlabip.xyz', 'hub.gitmirror.com', 'raw.githubusercontent.com']; //github镜像加速及源地址
        const jsonFile = '/chemhunter/biliadskip/refs/heads/main/biliadwordslinks.json';

        for (const source of gitSource) {
            const url = `https://${source}${jsonFile}?t=${Date.now()}`;
            try {
                const response = await fetch(url);
                if (!response.ok) {throw new Error(`HTTP错误! 状态码: ${response.status}`)};
                const text = await response.text();
                try {
                    const configData = JSON.parse(text);
                    console.log(`✅ 从git镜像: ${source} 获取到广告基础配置`);
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

    async function getAdWordsConfig(defaultConfig) {
        try {
            const localConfigStr = localStorage.getItem("localConfig");
            const localConfig = localConfigStr ? JSON.parse(localConfigStr) : null;
            const lastUpdateTime = localConfig && localConfig.time || 0;
            if ( Date.now() - lastUpdateTime > 3600*24*1000) {
                const res = await getConfigWithFallback();
                if (res) {
                    log(`⚙️ 配置信息:`, res);
                    biliAdWordsConfig = {
                        keywordStr: Object.values(res.keywordStr).join('|'),
                        biliAdLinks: res.biliAdLinks,
                        time: Date.now()
                    };
                    localStorage.setItem("localConfig", JSON.stringify(biliAdWordsConfig));
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
    }

    function log(...args) {
        console.log('[B站去充电广告] ', ...args);
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

    // 检查评论区广告
    function checkCommentTopAds() {
        const commentAds = document.querySelectorAll('.dynamic-card-comment .comment-list.has-limit .list-item.reply-wrap.is-top');
        commentAds.forEach(comment => {
            const links = comment.querySelectorAll('a');
            links.forEach(link => {
                const href = link.getAttribute('href');
                if (href && biliAdWordsConfig.biliAdLinks.some(blocked => href.includes(blocked))) {
                    hideItem(comment);
                    return 1;
                }
            });
        });
        return 0;
    }

    function checkCommentsForAds() {
        const commentsContainer = document.querySelector('#commentapp > bili-comments');
        if (commentsContainer && commentsContainer.shadowRoot) {
            const headerElement = commentsContainer.shadowRoot.querySelector("#header > bili-comments-header-renderer");
            if (headerElement && headerElement.shadowRoot) {
                const noticeElement = headerElement.shadowRoot.querySelector("#notice > bili-comments-notice");
                if (noticeElement && noticeElement.shadowRoot) {
                    const closeElement = noticeElement.shadowRoot.querySelector("#close");
                    if (closeElement) {
                        log("找到评论区横条，自动点击关闭按钮");
                        closeElement.click();
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
                                let foundAd = false;
                                const links = contentsElement.querySelectorAll('a');
                                links.forEach(link => {
                                    const href = link.getAttribute('href');
                                    if (href && biliAdWordsConfig.biliAdLinks.some(blocked => href.includes(blocked))) {
                                        foundAd = true;
                                    }
                                });

                                if (!foundAd) {
                                    foundAd = keywordRegex.test(contentsElement.textContent);
                                }

                                if (foundAd) {
                                    //log('发现广告：', contentText);
                                    hideItem(thread);
                                    hiddenAdCount++;
                                    window.MyObserver.disconnect();
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

    function checkForContentToHide() {
        let hiddenChargeCount = 0;
        let hiddenAdCount = 0;
        hideUnwantedElements()

        //B站首页
        if (window.location.hostname === 'www.bilibili.com' && !window.location.pathname.startsWith('/video/')) {
            // 处理 feed 卡片
            processFeedCards()

            // 隐藏推广的 feed 卡片
            const floorCards = document.querySelectorAll('.floor-single-card');
            floorCards.forEach(card => {
                hideItem(card);
            });

            //隐藏首页大屏
            const targetElement = document.querySelector('.recommended-swipe');
            hideItem(targetElement);

            //动态和个人空间页面
        } else if (window.location.hostname === 't.bilibili.com' || window.location.hostname === 'space.bilibili.com') {
            if (window.location.hostname === 't.bilibili.com') {
                hiddenAdCount += checkCommentTopAds();
            }
            const items = document.querySelectorAll('.bili-dyn-list__item');
            items.forEach(item => {
                const titleElement = item.querySelector('.bili-dyn-title');
                if (titleElement && whiteList.includes(titleElement.textContent.trim())) {
                    return;
                }
                const ask = item.querySelector('.dyn-icon-badge__renderimg.bili-dyn-item__iconbadge');
                const blockedmask = item.querySelector('.dyn-blocked-mask');
                const badge = item.querySelector('.bili-dyn-card-video__badge');
                const lotteryTitle = item.querySelector('.dyn-upower-lottery__title');
                const contentDiv = item.querySelector('.bili-dyn-content');
                const goods = item.querySelector('dyn-goods');
                const goods2 = item.querySelector('bili-dyn-card-goods');
                const spans = item.querySelectorAll('span');

                if (window.getComputedStyle(item).display !== 'none') {
                    if (goods || goods2) {
                        hideItem(item);
                        hiddenAdCount++;
                    } else if (blockedmask || ask ||
                               (badge && badge.textContent.includes('专属') ||
                                Array.from(spans).some(span => span.textContent.includes('专属')) ||
                                (lotteryTitle && lotteryTitle.textContent.includes('专属')))
                              ) {
                        hideItem(item);
                        hiddenChargeCount++;
                    } else if (contentDiv) {
                        const contentText = contentDiv.textContent;
                        if (keywordRegex.test(contentText)) {
                            hideItem(item);
                            hiddenAdCount++;
                        }
                    }
                }
                if (window.getComputedStyle(item).display !== 'none') {
                    spans.forEach(span => {
                        const dataUrl = span.getAttribute('data-url');
                        if (dataUrl && biliAdWordsConfig.biliAdLinks.some(blocked => dataUrl.includes(blocked))) {
                            hideItem(item);
                            hiddenAdCount++;
                        }
                    });
                }
            });
            //视频页面
        } else if (window.location.pathname.startsWith('/video/BV')) {
            if (!checkCommentsForAds()) {
                setTimeout(() => {
                    checkCommentsForAds();
                }, 2000);
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
        }
    }

    // 元素是否可见
    function isVisible(el) {
        return el && el.offsetParent !== null;
    }

    function hideUnwantedElements() {
        const unwantedSelectors = [
            '.bili-mini-mask',      // 视频区域的登录提示遮罩
            '.ad-report',           // 广告上报/“不喜欢”按钮
            '.video-card-ad-small', // 视频卡片形式的小广告
            '.video-share-wrap',     // 视频分享按钮区域
            '.activity-m-v1', //评论区上方活动推广条
            '.video-page-special-card-small', //右侧卡片栏混入的特殊卡片链接
            '.slide-ad-exp', //右侧上方弹幕列表下方的广告块
            'li.v-popover-wrap.left-loc-entry', //上方导航条末尾广告
            'ul.left-entry > li.v-popover-wrap:last-child', // 最后的 下载客户端
            '.bili-dyn-banner', //动态右侧公告栏
            '.reply-notice', //动态页面评论区上方提醒条
            'ul.right-entry > .vip-wrap',//顶部右侧 大会员按钮
        ];

        for (const selector of unwantedSelectors) {
            const element = document.querySelector(selector);
            if (element) {
                if (selector === '.bili-mini-mask') {
                    if (window.getComputedStyle(element).display !== 'none') {
                        hideItem(element);
                    }
                } else {
                    hideItem(element);
                }
            }
        }
    }

    //上方动态按钮触发弹窗
    function watchDynamicAllPanel() {
        dynamicPanelObserver = new MutationObserver(mutations => {
            for (const mutation of mutations) {
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === 1) {
                        const panel = node.querySelector('.dynamic-all');
                        if (panel) {
                            //log('✅ .dynamic-all 已插入，等待显示...');
                            const checkVisible = setInterval(() => {
                                if (isVisible(panel)) {
                                    //log('✅ .dynamic-all 已显示，执行广告过滤');
                                    filterDynamicPanelLinks(panel);
                                } else {
                                    clearInterval(checkVisible);
                                }
                            }, 300);
                        }
                    }
                }
            }
        });

        dynamicPanelObserver.observe(document.body, { childList: true, subtree: true });
        log('监听 document.body');
    }

    // 根据动态 title 和“专栏”标签判断是否广告，隐藏广告
    function filterDynamicPanelLinks() {
        const panel = document.querySelector('.dynamic-all');
        if (!panel) return;
        const links = panel.querySelectorAll(
            'a[data-mod="top_right_bar_window_dynamic"][data-idx="content"][title]'
        );
        let hiddenCount = 0;

        links.forEach(link => {
            if (isVisible(link)) {
                const title = link.getAttribute('title') || '';
                const tagSpan = link.querySelector(
                    '.dynamic-info-content > .all-in-one-article-title > .article-tag'
                );
                const isZhuanlan = tagSpan && tagSpan.textContent.trim() === '专栏';
                if (!isZhuanlan) return;
                if (title.includes("！") || keywordRegex.test(title)) {
                    let author = '未知';
                    const avatar = link.querySelector('.header-dynamic-avatar[title]');
                    if (avatar) {
                        author = avatar.getAttribute('title') || '';
                    }
                    if (!author) {
                        const usernameEl = link.querySelector('.user-name a[title]');
                        if (usernameEl) {
                            author = usernameEl.getAttribute('title') || usernameEl.textContent.trim();
                        }
                    }
                    log(`🚫「${author}」广告：${title}`);
                    link.style.display = 'none';
                    hiddenCount++;
                }
            }
        });

        if (hiddenCount > 0) {
            let message = `隐藏动态广告 x  ${hiddenCount} `;
            showMessage(message.trim());
            log(`✅ 已隐藏 ${hiddenCount} 条动态广告链接`);
        }
    }

    function debounce(func, wait) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    function initObserver() {
        // 将 const observer 改为 mainObserver
        mainObserver = new MutationObserver(debounce(checkForContentToHide, 250));
        mainObserver.observe(document.body,{ childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
        return mainObserver; // 返回实例
    }

    function restartObserver() {
        log('页面内容更新，重启观察器');
        if (window.MyObserver) {
            window.MyObserver.disconnect();
        }
        const observer = initObserver();
        window.MyObserver = observer;
    }

    // 监听 commentapp 元素的变化
    function initCommentAppObserver() {
        const commentAppElement = document.querySelector('#commentapp');
        if (commentAppElement) {
            commentAppObserver = new MutationObserver(restartObserver);
            commentAppObserver.observe(commentAppElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class']});
            log('启动commentapp 元素observer');
        }
    }

    // 初始化白名单
    const oldList = localStorage.getItem('whiteList');
    if (oldList) {localStorage.setItem('biliUpWhiteList', oldList);localStorage.removeItem('whiteList');}
    const whiteList = JSON.parse(localStorage.getItem('biliUpWhiteList')) || [];

    // 添加到白名单
    function addToWhiteList(upId) {
        if (!whiteList.includes(upId)) {
            whiteList.push(upId);
            localStorage.setItem('biliUpWhiteList', JSON.stringify(whiteList));
            updateWhiteListDisplay(); // 更新显示
        } else {
            alert(`${upId} 已在白名单中`);
        }
    }

    // 从白名单中移除
    function removeFromWhiteList(upId) {
        const index = whiteList.indexOf(upId);
        if (index !== -1) {
            whiteList.splice(index, 1);
            localStorage.setItem('biliUpWhiteList', JSON.stringify(whiteList));
            updateWhiteListDisplay(); // 更新显示
        } else {
            alert(`${upId} 不在白名单中`);
        }
    }

    // 检查是否在白名单中
    function isInWhiteList(upId) {
        return whiteList.includes(upId);
    }

    // 更新白名单显示
    function updateWhiteListDisplay() {
        const listDisplay = document.getElementById('whiteListDisplay');
        if (listDisplay) {
            listDisplay.textContent = whiteList.join(', ') || '白名单为空';
        }
    }

    // 显示白名单管理菜单
    function WhiteListMenu() {
        const adContainer = document.createElement('div');
        adContainer.id = 'kimiAdContainer';
        adContainer.style.cssText = `
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

        const Title = document.createElement('h4');
        Title.textContent = `手动管理白名单`;
        Title.style.cssText = 'text-align: center; margin-bottom: 20px;';
        adContainer.appendChild(Title);

        // 添加UP部分
        const addUpRow = document.createElement('div');
        addUpRow.style.cssText = 'display: flex; align-items: center; margin-bottom: 10px;';
        const addUpLabel = document.createElement('label');
        addUpLabel.textContent = '添加UP的ID：';
        addUpLabel.style.marginRight = '10px';
        addUpRow.appendChild(addUpLabel);

        const addUpInput = document.createElement('input');
        addUpInput.type = 'text';
        addUpInput.id = 'kimiaddUp';
        addUpInput.placeholder = '请输入UP的ID';
        addUpInput.style.flex = '0.7';
        addUpRow.appendChild(addUpInput);

        const saveButton = document.createElement('button');
        saveButton.textContent = '增加';
        saveButton.style.marginLeft = '20px';
        saveButton.style.padding = '0px 20px';
        saveButton.style.minWidth = '80px';
        saveButton.addEventListener('click', () => {
            const upId = addUpInput.value.trim();
            if (upId) {
                addToWhiteList(upId);
                addUpInput.value = ''; // 清空输入框
            }
        });
        addUpRow.appendChild(saveButton);
        adContainer.appendChild(addUpRow);

        // 删除UP部分
        const removeUpRow = document.createElement('div');
        removeUpRow.style.cssText = 'display: flex; align-items: center; margin-bottom: 10px;';
        const removeUpLabel = document.createElement('label');
        removeUpLabel.textContent = '删除UP的ID：';
        removeUpLabel.style.marginRight = '10px';
        removeUpRow.appendChild(removeUpLabel);

        const removeUpInput = document.createElement('input');
        removeUpInput.type = 'text';
        removeUpInput.id = 'kimiremoveUp';
        removeUpInput.placeholder = '请输入UP的ID';
        removeUpInput.style.flex = '0.7';
        removeUpRow.appendChild(removeUpInput);

        const deleteButton = document.createElement('button');
        deleteButton.textContent = '删除';
        deleteButton.style.marginLeft = '20px';
        deleteButton.style.padding = '0px 20px';
        deleteButton.style.minWidth = '80px';
        deleteButton.addEventListener('click', () => {
            const upId = removeUpInput.value.trim();
            if (upId) {
                removeFromWhiteList(upId);
                removeUpInput.value = ''; // 清空输入框
            }
        });
        removeUpRow.appendChild(deleteButton);
        adContainer.appendChild(removeUpRow);

        // 白名单列表显示区域
        const listDiv = document.createElement('div');
        listDiv.id = 'whiteListDisplay';
        listDiv.style.cssText = `
        text-align: center;
        color: #4CAF50;
        margin: 20px 0;
        padding: 10px;
        border: 1px dashed #ccc;
        border-radius: 5px;
        font-size: 14px;
        word-break: break-word;
        max-height: 150px;
        overflow-y: auto;
    `;
        listDiv.textContent = whiteList.join(', ') || '白名单为空';
        adContainer.appendChild(listDiv);

        // 完成按钮
        const finishButton = document.createElement('button');
        finishButton.textContent = '完成';
        finishButton.style.cssText = 'display: block; margin: 0 auto; padding: 5px 20px;';
        finishButton.addEventListener('click', () => {
            document.body.removeChild(adContainer);
        });
        adContainer.appendChild(finishButton);

        document.body.appendChild(adContainer);
    }

    // 注册菜单命令
    GM_registerMenuCommand("UP白名单", WhiteListMenu);

    const messageDiv = document.createElement('div');
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

    function reinitializeAllObservers() {
        log('执行重新初始化...');

        // 1. 断开所有可能存在的旧观察器
        if (window.MyObserver) window.MyObserver.disconnect();
        if (mainObserver) mainObserver.disconnect();
        if (commentAppObserver) commentAppObserver.disconnect();
        if (dynamicPanelObserver) dynamicPanelObserver.disconnect();

        // 2. 重新运行所有初始化逻辑
        window.MyObserver = initObserver();
        initCommentAppObserver();
        watchDynamicAllPanel();
        checkForContentToHide();
    }

    // 导航观察器 ---
    function setupNavigationObserver() {
        const observer = new MutationObserver(() => {
            const currentPathname = window.location.pathname;
            if (currentPathname !== lastPathname) {
                log(`检测到页面导航: ${lastPathname} -> ${currentPathname}`);
                lastPathname = currentPathname;
                debounce(reinitializeAllObservers, 500)();
            }
        });
        observer.observe(document.body, { childList: true, subtree: true });
        log('✅ 主导航观察器已启动');
    }

    async function initApp() {
        log('脚本加载，初始化');
        document.body.appendChild(messageDiv);
        await getAdWordsConfig(defaultConfig);
        lastPathname = window.location.pathname;
        reinitializeAllObservers();
        setupNavigationObserver();
    }

    initApp().catch(console.error);
})();
