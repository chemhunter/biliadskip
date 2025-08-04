// ==UserScript==
// @name         Bilibili-隐藏充电和广告
// @namespace    https://greasyfork.org/scripts/511437/
// @description  隐藏B站动态瀑布流中的广告、评论区广告、充电内容以及美化首页
// @version      1.25
// @author       chemhunter
// @match        *://t.bilibili.com/*
// @match        *://space.bilibili.com/*
// @match        *://www.bilibili.com/*
// @grant        GM_registerMenuCommand
// @icon         https://i0.hdslb.com/bfs/static/jinkela/long/images/favicon.ico
// @run-at       document-end
// @downloadURL https://update.greasyfork.org/scripts/511437/B%E7%AB%99%E9%9A%90%E8%97%8F%E5%85%85%E7%94%B5%E5%92%8C%E5%B9%BF%E5%91%8A.user.js
// @updateURL https://update.greasyfork.org/scripts/511437/B%E7%AB%99%E9%9A%90%E8%97%8F%E5%85%85%E7%94%B5%E5%92%8C%E5%B9%BF%E5%91%8A.meta.js
// @license      GPL-3.0 License

// ==/UserScript==

(function() {
    'use strict';

    const blockedKeywords = [
        '拼多多','淘宝','京东','天猫','手淘','旗舰店','运费','返现','甲方','催更','双11','双12','双十一','618','退款','保修','无门槛',             //购物平台
        '品牌方', '他们家','赞助', '溪木源', '海力生', '萌牙家', '妙界', '神气小鹿', 'DAWEI', '温眠', '友望', '转转',                       //品牌商家
        '特价','下单','礼包','补贴','领券','优惠','实惠','折扣','福利','评论区', '置顶链接','保价','限时','免费','专属',                     //商家话术
        '小冰被','工学椅','润眼','护肝','护颈','护眼','护枕','按摩','冲牙','牙刷','流量卡','肯德基','洗地机','鱼油',                        //产品功能
        '产品','成分','配比','配方','精粹','精华', '养护','美白','牙渍','牙菌斑','久坐','疲劳','白茶','好价','降价',
    ];

    const blockedLinks = [
        'taobao.com','tb.cn', 'jd.com', 'pinduoduo.com', 'mall.bilibili.com', 'gaoneng.bilibili.com', 'yangkeduo.com', 'zhuanzhuan.com', 'firegz.com', '52haoka.com','aiyo-aiyo.com', 'bilibili.com/cheese/'
    ];

    function log(...args) {
        console.log('[B站隐藏充电和广告] ', ...args);
    }

    function hideItem(item) {
        item.style.display = 'none';
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
                if (href && blockedLinks.some(blocked => href.includes(blocked))) {
                    hideItem(comment);
                    return 1;
                }
            });
        });
        return 0;
    }

    let hiddenAdCount = 0;

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

                                const contentText = contentsElement.textContent;
                                if (blockedKeywords.some(keyword => contentText.includes(keyword))) {
                                    foundAd = true;
                                }

                                const links = contentsElement.querySelectorAll('a');
                                links.forEach(link => {
                                    const href = link.getAttribute('href');
                                    if (href && blockedLinks.some(blocked => href.includes(blocked))) {
                                        foundAd = true;
                                    }
                                });

                                if (foundAd) {
                                    log('发现评论区广告');
                                    hideItem(thread);
                                    hiddenAdCount++;
                                    observer.disconnect();
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

    function checkForContentToHide() {
        let hiddenChargeCount = 0;
        let hiddenAdCount = 0;

        if (window.location.hostname === 't.bilibili.com' || window.location.hostname === 'space.bilibili.com') {
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
                        if (blockedKeywords.some(keyword => contentText.includes(keyword))) {
                            hideItem(item);
                            hiddenAdCount++;
                        }
                    }
                }
                if (window.getComputedStyle(item).display !== 'none') {
                    spans.forEach(span => {
                        const dataUrl = span.getAttribute('data-url');
                        if (dataUrl && blockedLinks.some(blocked => dataUrl.includes(blocked))) {
                            hideItem(item);
                            hiddenAdCount++;
                        }
                    });
                }
            });
        }

        if (window.location.hostname === 'www.bilibili.com' && !window.location.pathname.startsWith('/video/')) {
            // 隐藏推广的 feed 卡片
            const floorCards = document.querySelectorAll('.floor-single-card');
            floorCards.forEach(card => {
                if (window.getComputedStyle(card).display !== 'none'){
                    hideItem(card);
                }
            });

            // 隐藏没有视频内容的 feed 卡片
            const feedCards = document.querySelectorAll('.feed-card');
            feedCards.forEach(card => {
                const hasVideoWrap = card.querySelector('.bili-video-card__wrap');
                if (!hasVideoWrap) {
                    card.style.display = 'none';
                }
            });

            //隐藏首页大屏
            const targetElement = document.querySelector('.recommended-swipe');
            if (targetElement && window.getComputedStyle(targetElement).display !== 'none') {
                hideItem(targetElement);
            }
        }

        if (window.location.pathname.startsWith('/video/')) {
            if (!checkCommentsForAds()) {
                setTimeout(() => {
                    checkCommentsForAds();
                }, 2000);
            }
            const targetElement = document.querySelector('.bili-mini-mask');
            const popElement = document.querySelector('.v-popover');
            if (targetElement && window.getComputedStyle(targetElement).display !== 'none') {
                log('隐藏登录');
                hideItem(targetElement);
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

    //上方动态按钮触发弹窗
    function watchDynamicAllPanel() {
        const observer = new MutationObserver(mutations => {
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

        observer.observe(document.body, { childList: true, subtree: true });
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
                if (title.includes("！") || blockedKeywords.some(kw => title.includes(kw))) {
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
        const observer = new MutationObserver(debounce(checkForContentToHide, 250));
        observer.observe(document.body,{ childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
        return observer;
    }

    function restartObserver() {
        log('页面内容更新，重新启动observer');
        if (window.observer) {
            window.observer.disconnect();
        }
        const observer = initObserver();
        window.observer = observer;
    }

    // 监听 commentapp 元素的变化
    function initCommentAppObserver() {
        const commentAppElement = document.querySelector('#commentapp');
        if (commentAppElement) {
            const commentAppObserver = new MutationObserver(restartObserver);
            commentAppObserver.observe(commentAppElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class']});
            log('启动commentapp 元素observer');
        }
    }

    // 初始化白名单
    let whiteList = JSON.parse(localStorage.getItem('whiteList')) || [];

    // 添加到白名单
    function addToWhiteList(upId) {
        if (!whiteList.includes(upId)) {
            whiteList.push(upId);
            localStorage.setItem('whiteList', JSON.stringify(whiteList));
            //alert(`已将 ${upId} 添加到白名单`);
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
            localStorage.setItem('whiteList', JSON.stringify(whiteList));
            //alert(`已将 ${upId} 从白名单中移除`);
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
        color: #555;
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

    document.body.appendChild(messageDiv);

    log('脚本加载，初始化');
    const observer = initObserver();
    window.observer = observer;

    initCommentAppObserver();
    watchDynamicAllPanel();

})();