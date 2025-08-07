// ==UserScript==
// @name         Bilibili-AI跳视频广告
// @namespace    BiliAdSkipByAI
// @version      2.01
// @description  通过检测评论区置顶广告，点击AI小助手，提取字幕，发送给聊天AI获取广告时间戳，自动跳过广告时间段
// @author       chemhunter
// @match        https://www.bilibili.com/video/*
// @icon         https://i0.hdslb.com/bfs/static/jinkela/long/images/favicon.ico
// @require      https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js
// @grant        GM_registerMenuCommand

// ==/UserScript==

(function() {
    'use strict';

    const keywordList = [
        '拼多多','淘宝','京东','天猫','手淘','美团','饿了么','旗舰店','运费','返现','甲方','催更','双11','双12','双十一','618',                       //购物平台
        '特价','下单','礼包','补贴','领券','优惠','折扣','福利','评论区', '置顶链接','蓝链','退款','保价','限时','免费','专属',                     //商家话术
        '品牌方', '他们家','赞助', '溪木源', '海力生', '萌牙家', '妙界', '神气小鹿', 'DAWEI', '温眠', '友望', '转转','礼盒',                       //品牌商家
        '冰被','工学椅','润眼','护肝','护颈','颈椎','护眼','护枕','肩颈‘,’按摩','冲牙','牙刷','肯德基','洗地机','鱼油','氨糖',                      //产品功能
        '产品','成分','配比','配方','精粹','精华', '美白','牙渍','菌斑','久坐','疲劳','白茶','好价','降价','保养','控油',
        '质感','科技感','口碑','热销','自研','养护','流量','送礼','放心冲','大额','回购','低价','捡漏',
    ];

    const blockedLinks = [
        'taobao.com', 'tb.cn', 'jd.com', 'pinduoduo.com',
        'mall.bilibili.com', 'gaoneng.bilibili.com', 'b23.tv', 'bilibili.com/cheese/', 'app.biligame.com/',
        'yangkeduo.com', 'zhuanzhuan.com', 'goofish.com','m.zhuanzhuan.com', 'firegz.com', '52haoka.com','aiyo-aiyo.com',

    ];

    // 定义默认状态
    const defaultState = {
        currentBV: null,
        hasProcessedPopup: false,
        hasExtractedSubtitles: false,
        adTime: null,
        videoListenerAttached: null,
        lastSkipTime: 0,
        observer: null,
        commentText:"",
        cloudChecked: false,
    };

    const state = { ...defaultState };
    function resetState() {
        Object.assign(state, defaultState);
    }

    // 引入 Supabase
    const { createClient } = window.supabase;
    const supabase = createClient(
        'https://akoaopeqigjwpcksqdyf.supabase.co',
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFrb2FvcGVxaWdqd3Bja3NxZHlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQ0MDgwMzEsImV4cCI6MjA2OTk4NDAzMX0.6JW6Gtescu5btG25b3en9w84ZbO40Z4fy3iUfWROIOM'
    );

    // 查询云端
    async function fetchCloudAdTime(bvNumber) {
        log('尝试从云端查询广告时间戳');
        const { data, error } = await supabase
        .from('bili_ad_timestamps')
        .select('timestamp_range')
        .eq('bv', bvNumber)
        .order('created_at', { ascending: false })
        if (error || !data || data.length === 0) {
            log("云端无记录", error?.message);
            return null;
        }
        log(bvNumber, '云端返回数据', data);
        return data.map(entry => entry.timestamp_range);
    }

    // 上传云端
    async function uploadAdTimeToCloud(bvNumber, timeStampStr, source) {
        //查询云端记录数量
        const { data: existingRecords, error: countError } = await supabase
        .from('bili_ad_timestamps')
        .select('bv', { count: 'exact', head: true })
        .eq('bv', bvNumber);

        if (countError) {
            console.warn("查询云端记录数失败，尝试上传共享", countError.message);
        } else if (existingRecords && existingRecords.length >= 5) {
            log(`BV ${bvNumber} 云端已有 ${existingRecords.length} 条记录，跳过上传`);
            return;
        }

        if (typeof timeStampStr === 'object' && timeStampStr !== null && timeStampStr.start && timeStampStr.end) {
            timeStampStr = `${timeStampStr.start} - ${timeStampStr.end}`;
        }
        const user_id = getOrCreateUserId();
        const { error } = await supabase.from('bili_ad_timestamps').insert([
            { bv: bvNumber, timestamp_range: timeStampStr, user_id, source }
        ]);

        if (error) {
            console.warn("上传云端广告时间戳失败", bvNumber, timeStampStr, error.message);
        } else {
            log("已上传广告时间戳至云端", bvNumber, timeStampStr);
        }
    }

    function handleTimeUpdate(evt) {
        // 直接拿到绑定的 video
        const video = evt.target;
        const duration = video.duration;
        const currentTime = video.currentTime
        if (!state.adTime) {
            video.removeEventListener('timeupdate', handleTimeUpdate);
        } else {
            let start = timeToSeconds(state.adTime.start);
            let end = timeToSeconds(state.adTime.end);
            const now = Date.now();
            if (now - state.lastSkipTime < 1000) return;
            if (currentTime >= start && currentTime <= end) {
                if (duration - end <=5) {
                    end = duration
                }
                log(`跳过广告 ${state.adTime.start} – ${state.adTime.end}`);
                showJumpNotice(end)
                video.currentTime = end;
                state.lastSkipTime = now;
            }
        }
    }

    function setupAdSkipListener() {
        const video = document.querySelector('video');
        if (!video || state.videoListenerAttached) return;
        video.addEventListener('timeupdate', handleTimeUpdate);
        state.videoListenerAttached = true;
    }

    function getOrCreateUserId() {
        let userId = localStorage.getItem("biliadskip_user_id");
        if (!userId) {
            userId = generateRandomId(8);
            localStorage.setItem("biliadskip_user_id", userId);
        }
        return userId;
    }

    function generateRandomId(length) {
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        let result = "";
        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    function pickReliableTimestamp(cloudAdTimes) {
        if (!cloudAdTimes || cloudAdTimes.length === 0) return null;
        if (cloudAdTimes.length === 1) return cloudAdTimes[0];

        const parseRange = (rangeStr) => {
            const match = rangeStr.match(/(\d{2}:\d{2}:\d{2})\s*-\s*(\d{2}:\d{2}:\d{2})/);
            if (!match) return null;
            const toSec = (hms) => {
                const [h, m, s] = hms.split(':').map(Number);
                return h * 3600 + m * 60 + s;
            };
            return {
                start: toSec(match[1]),
                end: toSec(match[2]),
                duration: toSec(match[2]) - toSec(match[1]),
                raw: rangeStr,
            };
        };

        const parsed = cloudAdTimes.map(parseRange).filter(Boolean);
        if (parsed.length === 0) return null;

        // 用容差对 start 和 end 进行聚类（差异不超过 N 秒视为同一组）
        const tolerance = 3; // 容差秒数
        const clusterMap = [];

        for (const range of parsed) {
            let matched = false;
            for (const cluster of clusterMap) {
                const ref = cluster[0];
                if (
                    Math.abs(range.start - ref.start) <= tolerance &&
                    Math.abs(range.end - ref.end) <= tolerance
                ) {
                    cluster.push(range);
                    matched = true;
                    break;
                }
            }
            if (!matched) {
                clusterMap.push([range]);
            }
        }

        // 找到最大簇
        clusterMap.sort((a, b) => b.length - a.length);
        const topCluster = clusterMap[0];

        if (topCluster.length === 1) {
            return topCluster[0].raw;
        }

        // 从最大簇中选择中间值（以避免极端值）
        topCluster.sort((a, b) => a.start - b.start);
        return topCluster[Math.floor(topCluster.length / 2)].raw;
    }

    async function handlePageChanges() {
        if (state.isHandling) return; // 防止重入
        state.isHandling = true;

        try {
            const bvNumber = getBVNumber();
            if (!bvNumber) return;

            if (state.videoListenerAttached && bvNumber === state.currentBV) return;

            // 尝试从云端加载
            if (!state.cloudChecked) {
                state.cloudChecked = true;
                const cloudAdTimes = await fetchCloudAdTime(bvNumber);
                log('云端返回数据', cloudAdTimes);
                if (!cloudAdTimes || cloudAdTimes.length === 0) return;

                const reliableTimestamp = pickReliableTimestamp(cloudAdTimes);
                if (!reliableTimestamp) return;

                const dataTimestamp = extractTimestampFromAiResponse(reliableTimestamp);
                if (!dataTimestamp) return;

                state.adTime = dataTimestamp;
                storeAdTime(bvNumber, dataTimestamp);
                log('云端获取广告时间戳', dataTimestamp);
                setupAdSkipListener();
                return;
            }

            // 云端无数据，尝试本地缓存 dataTimestamp
            const dataTimestamp = state.adTime || getStoredAdTime(bvNumber);
            if (dataTimestamp) {
                monitorTimestamp(bvNumber, dataTimestamp, aiSelect.value);
                return;
            }

            // 本地也没有，尝试评论区分析
            if (!state.hasProcessedPopup) {
                const commentAnalysis = extractAndCheckComments();
                if (commentAnalysis.hasAds) {
                    state.commentText = commentAnalysis.commentText;
                    log('调用AI')
                    const dataTimestamp = await handleAIHelper();
                    if (dataTimestamp) {
                        monitorTimestamp(bvNumber, dataTimestamp, aiSelect.value);
                    }
                }
            }

        } finally {
            state.isHandling = false; // 释放锁
        }
    }

    function monitorTimestamp(bvNumber, dataTimestamp, source) {
        state.adTime = dataTimestamp;
        log('使用本地广告时间戳（并上传至云端）', dataTimestamp);
        uploadAdTimeToCloud(bvNumber, dataTimestamp, source);
        setupAdSkipListener();
    }

    function monitorPage() {
        const currentBV = getBVNumber();
        if (!currentBV) return;
        if (currentBV !== state.currentBV) {
            if (state.currentBV) {
                log("页面地址变化，重新初始化观察器");
            }
            if (state.observer) state.observer.disconnect();
            resetState();
            state.currentBV = currentBV;
            initObserver();
        }

        const video = document.querySelector('video');
        if (!video) return;

        if (state.adTime && !state.videoListenerAttached) {
            setupAdSkipListener();
        }
    }

    // 简单节流函数，每 200ms 最多执行一次 fn
    function throttle(fn, delay) {
        let lastCall = 0;
        return (...args) => {
            const now = Date.now();
            if (now - lastCall >= delay) {
                lastCall = now;
                fn(...args);
            }
        };
    }

    function initObserver() {
        const videoArea = document.querySelector('.bpx-player-video-area');
        if (videoArea) {
            setTimeout(() => {
                const throttledHandler = throttle(handlePageChanges, 200);
                state.observer = new MutationObserver(() => {
                    throttledHandler(); // 用节流包装后的处理函数
                });
                state.observer.observe(videoArea, { childList: true, subtree: true });
            }, 2000);// 延迟 2 秒后再开始监听
        }
    }

    function startMonitoring() {
        setInterval(monitorPage, 2000);
        initObserver();
    }

    startMonitoring();

    //------------------------------------------------
    function handleAIHelper() {
        if (state.hasProcessedPopup) return;
        const popupBody = document.querySelector('._Body_196qs_116');
        if (popupBody) {
            log('AI小助手窗口已弹出');
            state.hasProcessedPopup = true;
            processPopupContent(popupBody);
            return;
        }
        const button = document.querySelector('.video-ai-assistant');
        if (button) {
            log('尝试点击AI小助手按钮');
            button.click();
        }
        setTimeout(handleAIHelper, 1000);
    }

    function closePopup() {
        const closeButton = document.querySelector('._CloseBtn_196qs_87');
        if (closeButton) closeButton.click();
    }

    // 提取评论区文本并检测广告
    function extractAndCheckComments() {
        const commentsContainer = document.querySelector('#commentapp > bili-comments');
        if (!commentsContainer || !commentsContainer.shadowRoot) {
            console.log("未找到评论区容器");
            return { hasAds: false, commentText: "" };
        }

        const thread = commentsContainer.shadowRoot.querySelector('bili-comment-thread-renderer');
        if (!thread || !thread.shadowRoot) {
            return { hasAds: false, commentText: "" };
        }

        const commentRenderer = thread.shadowRoot.querySelector('#comment');
        if (!commentRenderer || !commentRenderer.shadowRoot) {
            return { hasAds: false, commentText: "" };
        }

        const richText = commentRenderer.shadowRoot.querySelector('#content > bili-rich-text');
        if (!richText || !richText.shadowRoot) {
            return { hasAds: false, commentText: "" };
        }

        const contentsElement = richText.shadowRoot.querySelector('#contents');
        if (!contentsElement) {
            return { hasAds: false, commentText: "" };
        }

        const commentText = contentsElement.textContent.trim();
        const links = contentsElement.querySelectorAll('a');
        let hasAds = false;
        for (const link of links) {
            const href = link.getAttribute('href');
            if (href && blockedLinks.some(blocked => href.includes(blocked))) {
                hasAds = true;
                break;
            }
        }
        if (!hasAds) { // 检查是否包含广告关键词
            hasAds = keywordList.some(keyword => commentText.includes(keyword));
        }
        return { hasAds: hasAds, commentText: commentText };
    }

    function processPopupContent(popupBody) {
        const tabItems = popupBody.querySelectorAll('._Tabs_krx6h_1 ._TabItem_krx6h_8');
        if (!tabItems) return;

        let subtitleTab = null;
        for (const tab of tabItems) {
            const label = tab.querySelector('._Label_krx6h_18');
            if (label && label.textContent.trim() === '字幕列表') {
                subtitleTab = tab;
                const isActive = subtitleTab.classList.contains('_Active_krx6h_36');
                if (isActive) {
                    log('字幕列表选项卡已激活');
                    waitForSubtitlesAndExtract(popupBody);
                } else {
                    subtitleTab.click();
                    log('字幕列表选项卡');
                    setTimeout(() => waitForSubtitlesAndExtract(popupBody), 2000);
                }
                break;
            }
        }
        if (!subtitleTab) log('未找到字幕列表选项卡');
        return;
    }

    async function waitForSubtitlesAndExtract(popupBody) {
        const subtitles = popupBody.querySelectorAll('._Part_1iu0q_16');
        const noSubtitlesElement = popupBody.querySelector('._EmptyTips_2jiok_17');
        const bvNumber = getBVNumber();
        const noAiSubtitle = '本视频暂无AI字幕'
        if (noSubtitlesElement && noSubtitlesElement.textContent.trim() === noAiSubtitle) {
            log(noAiSubtitle);
            closePopup();
            state.observer.disconnect();
            return;
        }

        if (subtitles.length > 0 && !state.hasExtractedSubtitles) {
            state.hasExtractedSubtitles = true;
            const filteredSubtitles = extractSubtitles(popupBody);
            log(`提取到疑似广告字幕条数：${filteredSubtitles.length}`);
            sendSubtitlesToAI(bvNumber, filteredSubtitles)
                .then(timestamps => {
                if (timestamps) {
                    state.adTime = timestamps;
                    storeAdTime(bvNumber, timestamps);
                }
            })
                .catch(error => {
                console.error("分析失败:", error);
            });
        } else if (!state.hasExtractedSubtitles) {
            setTimeout(() => waitForSubtitlesAndExtract(popupBody), 1000);
        }
    }

    //// 保存字幕到本地（仅限未下载）
    function trySaveSubtitles(subtitleArray) {
        const bvNumber = getBVNumber();
        const data = JSON.parse(localStorage.getItem(bvNumber) || '{}');
        if (!data.isdownloaded) {
            data.isdownloaded = true;
            localStorage.setItem(bvNumber, JSON.stringify(data));
            saveSubtitles(bvNumber, subtitleArray);
        } else {
            log(`跳过保存：视频 ${bvNumber}字幕 已下载`);
        }
    }

    function collectSubtitleObjects(popupBody) {
        const subtitles = popupBody.querySelectorAll('._Part_1iu0q_16');
        const subtitleObjects = [];

        subtitles.forEach((subtitle) => {
            const timeText = subtitle.querySelector('._TimeText_1iu0q_35').textContent;
            const contentText = subtitle.querySelector('._Text_1iu0q_64').textContent;
            subtitleObjects.push({ time: timeText, content: contentText });
        });

        return subtitleObjects;
    }

    function processForAdFiltering(subtitleArray, subtitleObjects) {
        const maxSubtitles = 400;
        if (subtitleArray.length < maxSubtitles) {
            return subtitleArray;
        }

        log(`字幕条数过多（${subtitleArray.length}条），尝试本地筛选广告片段...`);

        // 1. 提取关键词匹配的时间点（秒）+ 保留原始字幕对象
        const keywordMatches = subtitleObjects
        .map(obj => ({ sec: timeToSeconds(obj.time), obj }))
        .filter(entry => keywordList.some(keyword => entry.obj.content.includes(keyword)));

        if (keywordMatches.length === 0) {
            log(`未发现广告关键词，提取中间的${maxSubtitles}条`);
            const start = Math.floor((subtitleArray.length - maxSubtitles) / 2);
            return subtitleArray.slice(start, start + maxSubtitles);
        }
        keywordMatches.sort((a, b) => a.sec - b.sec);

        // 2. 找出分段点（相邻时间大于3分钟）
        const segments = [];
        let currentSegment = [keywordMatches[0]];

        for (let i = 1; i < keywordMatches.length; i++) {
            const prev = keywordMatches[i - 1].sec;
            const curr = keywordMatches[i].sec;
            if (curr - prev > 180) {
                segments.push(currentSegment);
                currentSegment = [];
            }
            currentSegment.push(keywordMatches[i]);
        }
        if (currentSegment.length > 0) {
            segments.push(currentSegment);
        }

        // 3. 输出关键词分布情况
        segments.forEach((segment, index) => {
            const segmentInfo = segment.map(entry => {
                const matchedKeyword = keywordList.find(keyword => entry.obj.content.includes(keyword));
                return `${formatTime(entry.sec)} ${matchedKeyword}`;
            });
            log(`疑似广告关键词分块${index + 1}: [${segmentInfo.join(', ')}]`);
        });

        // 4. 找到关键词数量最多的一段（你也可以选择最密集的段）
        const bestSegment = segments.reduce((a, b) => (a.length >= b.length ? a : b));
        const start = bestSegment[0].sec
        const end = bestSegment[bestSegment.length - 1].sec
        const ext = 120 - (end-start)/2
        const minTime = start - ext;
        const maxTime = end + ext;
        log("疑似广告区域", formatTime(minTime)+' - '+formatTime(maxTime));

        // 5. 提取疑似广告部分字幕
        const filteredSubtitles = subtitleObjects
        .filter(obj => {
            const sec = timeToSeconds(obj.time);
            return sec >= minTime && sec <= maxTime;
        })
        .map(obj => `${obj.time} ${obj.content}`);
        return filteredSubtitles;
    }

    function extractSubtitles(popupBody) {
        log('开始提取字幕');
        const subtitleObjects = collectSubtitleObjects(popupBody);
        closePopup();
        const subtitleArray = subtitleObjects.map(obj => `${obj.time} ${obj.content}`);
        trySaveSubtitles(subtitleArray);
        if (!state.adTime) {
            return processForAdFiltering(subtitleArray, subtitleObjects);
        }
        return;
    }

    // 保存字幕到本地（仅保存为 JSON 格式）
    function saveSubtitles(bvNumber, subtitles) {
        const titleEl = document.querySelector('.video-info-title h1.video-title');
        const title = titleEl ? titleEl.textContent.trim().replace(/[\\/:*?"<>|]/g, '') : '无标题';

        const authorEl = document.querySelector('.up-detail-top .up-name');
        const author = authorEl ? authorEl.textContent.trim().replace(/[\\/:*?"<>|]/g, '') : '未知UP';

        const fileName = `UP(${author})-${bvNumber}-${title}.json`;
        const blob = new Blob([JSON.stringify(subtitles, null, 2)], { type: 'application/json' });
        const urlObject = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = urlObject;
        a.download = fileName;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(urlObject);
        log(`字幕已保存到本地文件 ${fileName}`);
    }

    //公共AI服务
    async function callPublicAIService({
        platform = 'supabase', // 'supabase' | 'vercel'
        bvNumber,
        subtitles,
        user_id = getOrCreateUserId()
    }) {
        log('用户没填入有效 API Key，使用公共服务器');
        let endpoint;

        if (platform === 'supabase') {
            endpoint = 'https://akoaopeqigjwpcksqdyf.supabase.co/functions/v1/publicAI';
        } else if (platform === 'vercel') {
            endpoint = 'https://biliadskip.vercel.app/api/analyze';
        } else {
            console.error("未知的平台类型:", platform);
            return null;
        }

        const body = { bvNumber, subtitles, user_id };

        try {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const error = await response.text();
                console.warn(`${platform} 服务响应失败：`, response.status, error);
                return null;
            }

            const result = await response.json();
            console.log(`${platform} AI 返回结果：`, result);

            return result;

        } catch (err) {
            console.error(`请求 ${platform} AI 服务异常：`, err);
            return null;
        }
    }

    /*
 * 发送字幕到 AI 分析广告时间段（完整版）
 * @param {string[]} subtitles - 字幕数组
 * @param {string} bvNumber - 视频 BV 号
 * @param {object} state - 状态对象（用于存储 adTime）
 * @returns {Promise<{start: string, end: string} | null>}
 */

    async function sendSubtitlesToAI(bvNumber, subtitles) {
        // 1. 读取配置
        const cfg = JSON.parse(localStorage.getItem('AIConfig') || '{}');
        const {
            apiUrl = 'https://api.moonshot.cn/v1/chat/completions',
            model = 'moonshot-v1-auto',
            apiKey = null,
            maxRetries = 2,
        } = cfg;

        // 2. 参数校验
        if (!apiKey) {
            callPublicAIService({ platform: 'vercel', bvNumber, subtitles} )
        }

        if (!subtitles?.length) {
            console.warn(`[${bvNumber}] 字幕为空`);
            return null;
        }

        // 3. 构造请求
        const requestData = {
            model,
            messages: [
                {
                    role: 'system',
                    content: '你是一个视频字幕分析助手，能够识别广告时间段'
                },
                {
                    role: 'user',
                    content: `请分析以下视频字幕，分析哪段是口播广告部分，
                 告诉我广告部分的起止时间戳，广告部分一般不低于30秒，
                 且一般不会出现在视频的前3分钟,但也有例外。仅回复广告时间戳，
                 不要回复其他内容，如果你发现多段广告，回复我最像商业合作的那一段。
                 返回格式：\n广告开始 xx:xx \n广告结束 xx:xx \n\n${subtitles.join('\n')}\n\n
                 下面是评论区置顶广告文本，供你参考以精准识别广告：\n${state.commentText}`
                }
            ],
            temperature: 0.3,
            max_tokens: 100
        };

        // 4. 带重试的请求
        let retryCount = 0;
        while (retryCount < maxRetries) {
            try {
                const response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${apiKey}`
                    },
                    body: JSON.stringify(requestData)
                });

                if (response.status === 401) {
                    console.warn(`错误 401，用户的API Key 无效`);
                    return await callPublicAIService({ platform: 'vercel', bvNumber, subtitles});
                }

                if (!response.ok) {
                    const errorData = await response.json().catch(() => null);
                    throw new Error(`API 错误: ${response.status} - ${errorData?.error?.message || '未知错误'}`);
                }

                const data = await response.json();
                const aiResponse = data.choices?.[0]?.message?.content;
                if (!aiResponse) throw new Error('AI 返回数据格式异常');
                log("AI 返回数据", aiResponse)

                // 5. 提取时间戳并返回
                const dataTimestamp = extractTimestampFromAiResponse(aiResponse);
                if (dataTimestamp) {
                    log('提取到时间戳',dataTimestamp)
                    return dataTimestamp;
                } else {
                    console.warn(`[${bvNumber}] 未检测到广告时间段`);
                    return null;
                }

            } catch (error) {
                retryCount++;
                if (retryCount >= maxRetries) {
                    console.error(`[${bvNumber}] 请求失败 (${retryCount}次重试后):`, error);
                    throw error;
                }
                await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, retryCount)));
            }
        }
    }

    function extractTimestampFromAiResponse(content) {
        if (!content) return null;
        const match = content.match(/(\d{1,2}:\d{2}(?::\d{2})?)[^\d]+(\d{1,2}:\d{2}(?::\d{2})?)/);
        if (!match) return null;
        return {
            start: formatTime(match[1]),
            end: formatTime(match[2])
        };
    }

    function timeToSeconds(timestamp) {
        if (typeof timestamp !== 'string' || timestamp.trim() === '') {
            return
        }

        const parts = timestamp.split(':').map(part => {
            const num = Number(part);
            if (isNaN(num)) {
                throw new Error(`时间戳部分无效: ${part}`);
            }
            return num;
        });

        if (parts.length === 3) {
            const [hours, minutes, seconds] = parts;
            return hours * 3600 + minutes * 60 + seconds;
        } else if (parts.length === 2) {
            const [minutes, seconds] = parts;
            return minutes * 60 + seconds;
        } else {
            throw new Error(`无效的时间戳格式: ${timestamp}`);
        }
    }

    function formatTime(input) {
        if (typeof input === 'number') {
            const sec = Math.floor(input % 60).toString().padStart(2, '0');
            const min = Math.floor((input / 60) % 60).toString().padStart(2, '0');
            const hr = Math.floor(input / 3600).toString();
            return input >= 3600 ? `${hr}:${min}:${sec}` : `${min}:${sec}`;
        }

        if (typeof input === 'string') {
            const parts = input.split(':');
            if (parts.length === 3 && parts[0] === '00') {
                return parts.slice(1).join(':');
            }
            return input;
        }
    }

    function getBVNumber() {
        const url = new URL(window.location.href);
        const path = url.pathname;
        const match = path.match(/\/video\/(BV\w+)/);
        return match ? match[1] : null;
    }

    function storeAdTime(bvNumber, dataTimestamp) {
        const data = JSON.parse(localStorage.getItem(bvNumber) || '{}'); //读取整个配置，防止覆盖掉其他参数
        data.dataTimestamp = dataTimestamp;
        localStorage.setItem(bvNumber, JSON.stringify(data));
        log(`[${bvNumber}] 广告时间已本地存储: ${dataTimestamp.start} - ${dataTimestamp.end}`);
    }

    function getStoredAdTime(bvNumber) {
        const data = JSON.parse(localStorage.getItem(bvNumber) || '{}');
        state.adTime = data.dataTimestamp
        return data.dataTimestamp
    }

    function printAllStoreddataTimestamp() {
        log(`--打印已存储视频广告时间戳列表--`);
        const keys = Object.keys(localStorage);
        const bvNumberKeys = keys.filter(key => key.startsWith('BV1'));

        if (bvNumberKeys.length === 0) {
            log('没有找到任何保存的广告时间戳');
            return;
        }

        bvNumberKeys.forEach(bvNumber => {
            const data = JSON.parse(localStorage.getItem(bvNumber) || '{}');
            if (data.dataTimestamp) {
                log(`视频 ${bvNumber} : [${data.dataTimestamp.join(', ')}]`);
            }
        });
    }

    function log(...args) {
        console.log('[B站AI跳视频广告] ', ...args);
    }

    function showJumpNotice(ts) {
        const container = document.querySelector('.bpx-player-video-wrap');
        if (!container) return;
        const box = document.createElement('div');
        box.innerText = 'AI跳过广告 ⏩ ' + formatTime(ts);
        Object.assign(box.style, {
            position: 'absolute',
            bottom: '-20px',
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '6px 12px',
            backgroundColor: 'rgba(0, 0, 0, 0.4)',
            color: '#fff',
            fontSize: '16px',
            fontWeight: 'bold',
            borderRadius: '8px',
            zIndex: '9999',
            pointerEvents: 'none',
            opacity: '0',
            transition: 'opacity 0.3s ease'
        });

        container.style.position = 'relative';
        container.appendChild(box);
        requestAnimationFrame(() => {
            box.style.opacity = '1';
        });
        setTimeout(() => {
            box.style.opacity = '0';
            setTimeout(() => box.remove(), 500);
        }, 4000);
    }
    //////////////////////////////////////////////////////////////////////

    // 创建配置界面
    const configContainer = document.createElement('div');
    configContainer.id = 'kimiConfigContainer';
    configContainer.style.cssText = `
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
display: none;
font-size: 16px; /* 增大字体大小 */
box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2); /* 添加阴影效果 */
`;

    const configTitle = document.createElement('h3');
    configTitle.textContent = 'B站AI跳广告配置';
    configTitle.style.cssText = 'text-align: center; margin-bottom: 20px;';
    configContainer.appendChild(configTitle);

    // AI选择
    const aiSelectRow = document.createElement('div');
    aiSelectRow.style.cssText = 'display: flex; align-items: center; margin-bottom: 10px; gap: 10px;'; // 移除justify-content，添加gap控制间距
    const aiSelectLabel = document.createElement('label');
    aiSelectLabel.textContent = '选择个AI：';
    aiSelectLabel.style.flexShrink = '0';
    aiSelectRow.appendChild(aiSelectLabel);

    const aiSelect = document.createElement('select');
    aiSelect.id = 'kimiAiSelect';
    aiSelect.style.flex = '1';
    aiSelect.style.minWidth = '0';

    const aiOptions = [
        { value: 'kimi', text: 'Kimi', apiUrl: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-8k' },
        { value: 'deepseek', text: 'DeepSeek', apiUrl: 'https://api.deepseek.com/v1/chat/completions', model: 'deepseek-chat' },
        { value: 'openai', text: 'ChatGPT', apiUrl: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4' },
        { value: 'custom', text: '自定义AI', apiUrl: '', model: '' }
    ];

    aiOptions.forEach(option => {
        const optElement = document.createElement('option');
        optElement.value = option.value;
        optElement.textContent = option.text;
        aiSelect.appendChild(optElement);
    });
    aiSelectRow.appendChild(aiSelect);
    configContainer.appendChild(aiSelectRow);

    // API Key
    const apiKeyRow = document.createElement('div');
    apiKeyRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;';
    const apiKeyLabel = document.createElement('label');
    apiKeyLabel.textContent = 'API KEY：';
    apiKeyRow.appendChild(apiKeyLabel);

    const apiKeyInput = document.createElement('input');
    apiKeyInput.type = 'text';
    apiKeyInput.id = 'kimiApiKey';
    apiKeyInput.placeholder = '请输入API Key';
    apiKeyInput.style.width = 'calc(100% - 90px)';
    apiKeyRow.appendChild(apiKeyInput);
    configContainer.appendChild(apiKeyRow);

    // API URL
    const apiUrlRow = document.createElement('div');
    apiUrlRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;';
    const apiUrlLabel = document.createElement('label');
    apiUrlLabel.textContent = 'API URL：';
    apiUrlRow.appendChild(apiUrlLabel);

    const apiUrlInput = document.createElement('input');
    apiUrlInput.type = 'text';
    apiUrlInput.id = 'kimiApiUrl';
    apiUrlInput.placeholder = '请输入API URL';
    apiUrlInput.style.width = 'calc(100% - 90px)';
    apiUrlRow.appendChild(apiUrlInput);
    configContainer.appendChild(apiUrlRow);

    // Model
    const modelRow = document.createElement('div');
    modelRow.style.cssText = 'display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px;';
    const modelLabel = document.createElement('label');
    modelLabel.textContent = '模型名称：';
    modelRow.appendChild(modelLabel);

    const modelInput = document.createElement('input');
    modelInput.type = 'text';
    modelInput.id = 'kimiModel';
    modelInput.placeholder = '请输入模型名称';
    modelInput.style.width = 'calc(100% - 90px)';
    modelRow.appendChild(modelInput);
    configContainer.appendChild(modelRow);

    function createLink(text, url, container) {
        const link = document.createElement('a');
        link.href = url;
        link.textContent = text;
        link.style.cssText = 'color: blue; margin: 0 10px; text-decoration: none;';
        link.target = '_blank';
        container.appendChild(link);
    }

    // 链接的容器
    const linksContainer = document.createElement('div');
    linksContainer.style.cssText = 'margin-top: 20px; text-align: center;';
    const descriptionText = document.createTextNode('免费申请 API Key 地址：');
    linksContainer.appendChild(descriptionText);


    createLink('Kimi', 'https://platform.moonshot.cn/console/api-keys/', linksContainer);
    createLink('Deepseek', 'https://platform.deepseek.com/', linksContainer);
    createLink('硅基流动', 'https://cloud.siliconflow.cn/sft-keejoek1ys/account/ak', linksContainer);

    configContainer.appendChild(linksContainer);

    // 按钮容器
    const buttonContainer = document.createElement('div');
    buttonContainer.style.cssText = 'margin-top: 20px; display: flex; justify-content: center; gap: 10px;';
    configContainer.appendChild(buttonContainer);

    // 保存配置按钮
    const saveButton = document.createElement('button');
    saveButton.textContent = '保存配置';
    saveButton.id = 'kimiSaveConfig';

    // 关闭按钮
    const cancelButton = document.createElement('button');
    cancelButton.textContent = '关闭';
    cancelButton.id = 'kimiCancelConfig';

    // 将两个按钮添加到容器中
    buttonContainer.appendChild(saveButton);
    buttonContainer.appendChild(cancelButton);

    // 配置界面的显示与隐藏
    function showConfig() {
        configContainer.style.display = 'block';
    }

    function hideConfig() {
        configContainer.style.display = 'none';
    }

    // 加载本地存储的配置
    function loadConfig() {
        const storedConfig = JSON.parse(localStorage.getItem('AIConfig') || '{}');
        aiSelect.value = storedConfig.ai || 'Kimi';
        apiKeyInput.value = storedConfig.apiKey || '';
        apiUrlInput.value = storedConfig.apiUrl || '';
        modelInput.value = storedConfig.model || '';

        // 加载当前 AI 服务的 API Key
        const apiKeyStorageKey = `apiKey_${aiSelect.value}`;
        apiKeyInput.value = localStorage.getItem(apiKeyStorageKey) || '';

        // 根据选择的AI服务自动填充API URL、模型名称和API Key
        const selectedOption = aiOptions.find(option => option.value === aiSelect.value);
        if (selectedOption) {
            apiUrlInput.value = selectedOption.apiUrl;
            modelInput.value = selectedOption.model;
        }
    }

    // 保存配置到本地存储
    function saveConfig() {
        const AIConfig = {
            ai: aiSelect.value,
            apiKey: apiKeyInput.value,
            apiUrl: apiUrlInput.value,
            model: modelInput.value
        };
        localStorage.setItem('AIConfig', JSON.stringify(AIConfig));
        // 保存当前 AI 服务的 API Key
        const apiKeyStorageKey = `apiKey_${aiSelect.value}`;
        localStorage.setItem(apiKeyStorageKey, apiKeyInput.value);
        alert('配置已保存！');
        hideConfig(); // 保存后隐藏配置界面
        printAllStoreddataTimestamp();
    }

    // 根据选择的AI服务自动填充API URL和模型名称
    aiSelect.addEventListener('change', () => {
        const selectedOption = aiOptions.find(option => option.value === aiSelect.value);
        if (selectedOption) {
            apiUrlInput.value = selectedOption.apiUrl;
            modelInput.value = selectedOption.model;
            // 加载对应 AI 服务的 API Key
            const apiKeyStorageKey = `apiKey_${aiSelect.value}`;
            apiKeyInput.value = localStorage.getItem(apiKeyStorageKey) || '';
        } else {
            apiUrlInput.value = '';
            modelInput.value = '';
            apiKeyInput.value = '';
        }
    });

    //界面初始化
    document.body.appendChild(configContainer);
    loadConfig();
    saveButton.addEventListener('click', saveConfig);
    cancelButton.addEventListener('click', hideConfig);

    // 注册油猴菜单命令
    GM_registerMenuCommand("1-配置脚本AI", showConfig);

    // 手动添加本页广告时间戳
    function adddataTimestamptamp() {
        const bvNumber = getBVNumber(); // 获取当前页面的BV号
        if (!bvNumber) {
            alert('无法获取当前视频的BV号，请确保您在B站视频页面上');
            return;
        }

        const dataTimestamptampContainer = document.createElement('div');
        dataTimestamptampContainer.id = 'kimidataTimestamptampContainer';
        dataTimestamptampContainer.style.cssText = `
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

        const dataTimestamptampTitle = document.createElement('h4');
        dataTimestamptampTitle.textContent = `手动添加本页广告时间戳 ${bvNumber}`;
        dataTimestamptampTitle.style.cssText = 'text-align: center; margin-bottom: 20px;';
        dataTimestamptampContainer.appendChild(dataTimestamptampTitle);

        const data = JSON.parse(localStorage.getItem(bvNumber) || '{}');
        const start = data?.dataTimestamp?.start || '';
        const end = data?.dataTimestamp?.end || '';

        const startTimeRow = createTimeInputRow('起始：', 'kimiStartTime', start);
        const endTimeRow = createTimeInputRow('结束：', 'kimiEndTime', end);
        dataTimestamptampContainer.appendChild(startTimeRow);
        dataTimestamptampContainer.appendChild(endTimeRow);

        function createTimeInputRow(labelText, inputId, storedValue) {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; align-items: center; margin-bottom: 10px;';

            const label = document.createElement('label');
            label.textContent = labelText;
            label.style.cssText = 'width: 50px; text-align: right; margin-right: 10px; margin-left: 50px;';
            row.appendChild(label);

            const wrapper = document.createElement('div');
            wrapper.style.cssText = 'position: relative; flex: 1.0; max-width: 240px;';

            const input = document.createElement('input');
            input.type = 'text';
            input.id = inputId;
            input.placeholder = '格式 00:00';
            input.style.cssText = 'width: 100%; box-sizing: border-box;';
            if (storedValue) input.value = storedValue;
            wrapper.appendChild(input);

            if (storedValue) {
                const hintSpan = document.createElement('span');
                hintSpan.textContent = '(读取自本地存储)';
                hintSpan.style.cssText = `
            position: absolute;
            right: 6px;
            font-size: 12px;
            opacity: 0.6;
            pointer-events: none;
        `;
                wrapper.appendChild(hintSpan);
            }

            row.appendChild(wrapper);

            // “跳至此处”按钮
            const jumpBtn = document.createElement('button');
            jumpBtn.textContent = '跳至此处';
            jumpBtn.style.cssText = `
        margin-left: 10px;
        padding: 4px 8px;
        font-size: 12px;
        cursor: pointer;
    `;
            jumpBtn.addEventListener('click', () => {
                const video = document.querySelector('video');
                const timeStr = input.value.trim();
                if (!video || !timeStr) return;
                const timeSec = timeToSeconds(timeStr);
                if (!isNaN(timeSec)) {
                    video.currentTime = timeSec;
                    video.play();
                } else {
                    alert('时间格式不正确，应为 00:00');
                }
            });
            row.appendChild(jumpBtn);

            return row;
        }

        // 保存按钮
        const saveTimestampButton = document.createElement('button');
        saveTimestampButton.textContent = '保存';
        saveTimestampButton.id = 'kimiSaveTimestamp';
        saveTimestampButton.style.cssText = 'margin-right: 10px;'; // 添加右边距

        // 关闭按钮
        const cancelTimestampButton = document.createElement('button');
        cancelTimestampButton.textContent = '关闭';
        cancelTimestampButton.id = 'kimiCancelTimestamp';
        cancelTimestampButton.style.cssText = 'margin-left: 10px;'; // 添加左边距

        // 按钮容器
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = 'display: flex; justify-content: center; align-items: center; margin-top: 20px;';
        buttonContainer.appendChild(saveTimestampButton);
        buttonContainer.appendChild(cancelTimestampButton);
        dataTimestamptampContainer.appendChild(buttonContainer);

        /* ====== 新增：如果本地已有数据，则加“删除”按钮 ====== */
        if (getStoredAdTime(bvNumber)) {
            const delBtn = document.createElement('button');
            delBtn.textContent = '删除该页时间戳';
            delBtn.style.marginLeft = '20px';
            delBtn.style.color = '#e74c3c';
            delBtn.onclick = () => {
                localStorage.removeItem(bvNumber);
                state.adTime = null;
                // 清空输入框
                //document.getElementById('kimiStartTime').value = '';
                //document.getElementById('kimiEndTime').value = '';

                // 移除所有提示 span
                dataTimestamptampContainer.querySelectorAll('span[style*="opacity: 0.75"]').forEach(s => s.remove());

                // 移除事件监听
                const video = document.querySelector('video');
                if (video && state.videoListenerAttached) {
                    video.removeEventListener('timeupdate', handleTimeUpdate);
                    state.videoListenerAttached = false;
                }

                // 隐藏删除按钮
                delBtn.remove();
            };
            buttonContainer.appendChild(delBtn);
        }

        document.body.appendChild(dataTimestamptampContainer);

        saveTimestampButton.addEventListener('click', () => {
            const startTime = startTimeInput.value.trim();
            const endTime = endTimeInput.value.trim();
            if (startTime && endTime) {
                // 检查时间格式是否正确
                const timeRegex = /^(\d{1,2}:\d{2}(:\d{2})?)$/;
                if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
                    alert('请输入正确的时间格式（例如：05:30 或 01:30:45）');
                    return;
                }

                // 保存广告时间戳到本地存储
                const dataTimestamp = { start: startTime, end: endTime };
                storeAdTime(bvNumber, dataTimestamp);
                state.adTime = dataTimestamp;
                state.videoListenerAttached = null;
                document.body.removeChild(dataTimestamptampContainer);
            } else {
                alert('请输入完整的广告时间戳！');
            }
        });
        cancelTimestampButton.addEventListener('click', () => {
            document.body.removeChild(dataTimestamptampContainer);
        });
    }

    GM_registerMenuCommand("2-管理时间戳", adddataTimestamptamp);

})();
