// ==UserScript==
// @name             BiliAdSkipper
// @namespace    BiliAdSkipper
// @description  通过提取AI字幕、弹幕提醒，获取广告时间戳，自动跳过广告时间段
// @version      2.11
// @author       BiliAdSkipper
// @match        https://www.bilibili.com/video/*
// @connect      www.gitlabip.xyz
// @connect      hub.gitmirror.com
// @connect      raw.githubusercontent.com
// @grant        GM_registerMenuCommand
// @icon         https://i0.hdslb.com/bfs/static/jinkela/long/images/favicon.ico
// @require      https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js
// ==/UserScript==

(function() {
    'use strict';

    //临时调试开关
    const Debug = true;
    //supabase || vercel
    const cloudPlatformService = 'vercel';

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
            if (Debug || Date.now() - lastUpdateTime > 3600*24*1000) {
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

    const defaultState = {
        currentBV: null,
        hasProcessedPopup: false,
        hasExtractedSubtitles: false,
        adTime: null,
        video: null,
        lastJumpTime: 0,
        observer: null,
        isVideoPlaying: false,
        commentText:"",
        bvCloudChecked: false,
        uploaded: false,
        upid: '',
        noAd: false,
        cloudAdTimes:[],
        DanmakuAdtimeSaved:{},
    };

    const state = { ...defaultState };

    function resetState() {
        Object.assign(state, defaultState);
    }

    // Supabase
    const { createClient } = window.supabase;
    const auth = [
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
        'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFrb2FvcGVxaWdqd3Bja3NxZHlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQ0MDgwMzEsImV4cCI6MjA2OTk4NDAzMX0',
        '6JW6Gtescu5btG25b3en9w84ZbO40Z4fy3iUfWROIOM',
    ];
    const supabase = createClient(
        'https://akoaopeqigjwpcksqdyf.supabase.co', auth.join('.'));

    // 查询云端
    async function fetchAdTimeDataFromSupabase(bvNumber) {
        log('尝试查询广告时间戳');
        const { data, error } = await supabase
        .from('bili_ad_timestamps_public')
        .select('timestamp_range, source, NoAD')
        .eq('bv', bvNumber)
        .order('created_at', { ascending: false })
        if (error || !data || data.length === 0) {
            log("云端无记录", error?.message);
            return null;
        }
        log(bvNumber, '云端返回数据', data);
        return data;
    }

    // 上传时间戳到 Supabase 数据库
    async function sendAdTimeDataToSupabase(bv, timestamp_range, source) {
        try {
            const dataBody = {
                bv,
                timestamp_range,
                source,
                user_id: getOrCreateUserId(),
                UP_id: state.upid || getUpid() || 'unknown'
            };

            const Resp = await fetch("https://akoaopeqigjwpcksqdyf.supabase.co/functions/v1/biliadskip", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(dataBody)
            });

            if (!Resp.ok) {
                const errorText = await Resp.text();
                console.error("调用接口失败：", Resp.status, Resp.statusText, errorText);
                return { success: false, error: errorText };
            }

            const biliadskipJson = await Resp.json();
            debuglog("已上传广告时间戳", bv, timestamp_range);
            return { success: true, biliadskip_result: biliadskipJson };

        } catch (err) {
            console.error("调用接口异常：", err);
            return { success: false, error: err.message || err };
        }
    }

    // 绑定视频timeupdate事件的回调函数
    // 公共跳转判断函数，尝试跳转广告时间戳，返回是否跳转成功
    function handleTimeUpdate() {
        if (!state.isVideoPlaying) return;
        if ((!state.adTime && timestampCounter.size === 0) || !state.video) return false;
        const video = state.video;
        const currentTime = state.video.currentTime;
        const duration = state.video.duration;
        const now = Date.now();
        const timeSinceLastJump = now - state.lastJumpTime;

        // 处理基于缓存时间戳的跳转
        if (state.adTime) {
            let start = timeToSeconds(state.adTime.start);
            let end = timeToSeconds(state.adTime.end);
            if (timeSinceLastJump < MIN_JUMP_INTERVAL*1000) return false; //两次跳转最小时间间隔
            if (currentTime >= start && currentTime <= end) {
                if (duration - end <= 5) {
                    end = duration;
                }
                JumpAndShowNotice(video, start, end, now)
                return true;
            }
        }

        // 处理基于弹幕时间戳的跳转（timestampCounter）
        for (const [ts, count] of timestampCounter) {
            const lastHandled = processedTimestamps.get(ts) || 0;
            const shouldJump =
                  count >= MIN_COUNT_TO_LOG && //真正广告时间戳
                  ts - currentTime > 10 &&// 跳转时间戳在当前位置后面至少10s（跳转宽度不能太短）
                  ts - currentTime < 240 && // 跳转时间戳在当前位置后面4分钟内
                  ts < duration - 60 && //最后60s不跳
                  currentTime > 30; // 前30s不跳

            if (shouldJump) {
                if (timeSinceLastJump < MIN_JUMP_INTERVAL * 1000) {
                    log('[跳转抑制] 防止频繁跳转');
                    return false;
                }
                log(`广告时间戳 ${formatTime(ts)}，计数：${count}`);
                JumpAndShowNotice(video, currentTime, ts, now);
                processedTimestamps.set(ts, now);

                const bv = state.currentBV;
                const result = getStoredAdTime(bv);
                if (!result || (result &&result !=="noAd" && result.adTime && !result.adTime.Danmaku )) {
                    const dataTimestamp = { start: formatTime(currentTime), end: formatTime(ts)};
                    const source = "Danmaku";
                    storeAdTime(bv, dataTimestamp , source);
                    const timestamp_range = `${formatTime(currentTime)} - ${formatTime(ts)}`;
                    log('弹幕时间戳已发现，尝试上传:', timestamp_range);
                    sendAdTimeDataToSupabase(bv, timestamp_range, source);
                    state.uploaded = true; // 设置标志，防止本页面的其他逻辑再次上传
                    // --- 核心修复：立即更新状态并停止监听 ---
                    state.adTime = dataTimestamp;
                    stopDanmakuObservation();
                    // --- 修复结束 ---
                }
                return true;
            }
        }
        return false;
    }

    function JumpAndShowNotice(video, start, end, now) {
        log(`✅[跳转成功] 已从 ${formatTime(start)} 跳转至 ⏩${formatTime(end)}`);
        video.currentTime = end;
        state.lastJumpTime = now;
        const container = document.querySelector('.bpx-player-video-wrap');
        if (!container) return;
        const box = document.createElement('div');
        box.innerText = `跳至 ⏩ ${formatTime(end)}`;
        Object.assign(box.style, {
            position: 'absolute',
            top: '15%',
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
            opacity: '0.8',
            transition: 'opacity 0.3s ease'
        });
        container.style.position = 'relative';
        container.appendChild(box);
        setTimeout(() => {
            box.remove();
        }, 3000);
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

    async function handlePageChanges(mainObserver) {
        // 如果没有传入 observer 或者正在处理中，则直接返回
        if (!mainObserver || state.isHandling) return;

        // 关键第一步：立即停止监听，防止雪崩效应
        mainObserver.disconnect();
        log('⏸️ 主导航观察器已暂停');

        state.isHandling = true;

        try {
            const bvNumber = getBVNumber();
            if (!bvNumber) return; // 如果已经不是视频页了，就不用继续了

            log(`开始处理 BV: ${bvNumber}`);

            // 只有当BV号确实发生变化时，才执行重置操作
            if (state.currentBV && bvNumber !== state.currentBV) {
                log(`BV 变更：${state.currentBV} -> ${bvNumber}，重置状态`);
                if (state.videoAreaObserver) state.videoAreaObserver.disconnect();
                stopDanmakuObservation();
                resetState();
            }

            state.currentBV = bvNumber;

            // 调用带等待功能的 initPageObserver，并等待它完成
            await initPageObserver();

            // 在播放器准备好之后，再处理广告逻辑
            await processBV(bvNumber);

        } catch (error) {
            console.error('[B站AI跳广告] 处理页面变化时发生错误:', error);
        } finally {
            // 关键最后一步：无论成功还是失败，都完成处理，并重新“武装”观察器
            state.isHandling = false;
            mainObserver.observe(document.body, { childList: true, subtree: true });
            log('▶️ 主导航观察器已恢复');
        }
    }

    function pickReliableTimestamp(cloudAdTimes) {
        log('分析云端返回数据')
        if (!cloudAdTimes || cloudAdTimes.length === 0) return null;
        if (cloudAdTimes.length === 1) {
            return cloudAdTimes[0]; //返回唯一数据
        }
        const noAdRecord = cloudAdTimes.find(item => item.NoAD === true);
        if (noAdRecord) {
            return noAdRecord;
        }

        const parseRange = (rangeStr) => {
            const match = rangeStr.match(/(\d{1,2}:\d{2}(?::\d{2})?)\s*-\s*(\d{1,2}:\d{2}(?::\d{2})?)/);
            if (!match) return null;
            return {
                start: timeToSeconds(match[1]),
                end: timeToSeconds(match[2]),
                duration: timeToSeconds(match[2]) - timeToSeconds(match[1]),
                raw: rangeStr,
            };
        };

        // 这里改成解析对象数组，从对象取 timestamp_range 字符串
        const parsed = cloudAdTimes.map(item => {
            const range = parseRange(item.timestamp_range);
            if (!range) return null;
            return { ...range, source: item.source };
        }).filter(Boolean);

        if (parsed.length === 0) return null;

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

        clusterMap.sort((a, b) => b.length - a.length);
        const topCluster = clusterMap[0];

        if (topCluster.length === 1) {
            return { timestamp_range: topCluster[0].raw, source: topCluster[0].source };
        } else {
            topCluster.sort((a, b) => a.start - b.start);
            const mid = topCluster[Math.floor(topCluster.length / 2)];
            return { timestamp_range: mid.raw, source: mid.source };
        }
    }

    async function processBV(bvNumber) {
        if (!state.upid) {state.upid = getUpid()};

        if (whiteList.includes(state.upid)) {
            log(`UP主 ${state.upid} 在白名单中，跳过广告检测`);
            stopDanmakuObservation(); // 停止弹幕监听
            return;
        }

        if (state.noAd) {
            log('该视频已被标记为无广告，跳过后续检测');
            stopDanmakuObservation();
            return;
        }

        if (state.adTime && danmakuInterval) {
            stopDanmakuObservation();
        }

        const VIP = document.querySelector('.bpx-player-trial-watch-charging-toast') || document.querySelector('.high-level-video-cover')
        if (VIP) {
            log('充电专属视频，跳过广告检测');
            state.noAd = true;
            return false;
        }

        if (!state.bvCloudChecked) {
            state.bvCloudChecked = true;
            const cloudRecords = await fetchAdTimeDataFromSupabase(bvNumber);
            if (cloudRecords && cloudRecords.length > 0) {
                state.cloudAdTimes = cloudRecords;
                const reliable = pickReliableTimestamp(cloudRecords);
                if (reliable) {
                    if (reliable.NoAD) {
                        const data = JSON.parse(localStorage.getItem(bvNumber) || '{}')
                        data.noAd = true;
                        state.noAd = true;
                        localStorage.setItem(bvNumber, JSON.stringify(data));
                        log('云端返回：noAd，本地记录');
                        return;
                    } else {
                        const dataTimestamp = extractTimestampFromString(reliable.timestamp_range);
                        if (dataTimestamp) {
                            state.adTime = dataTimestamp;
                            storeAdTime(bvNumber, dataTimestamp, reliable.source);
                            log(`加载云端广告时间戳: ${dataTimestamp}, 来源: ${reliable.source}`);
                            state.video.addEventListener('timeupdate', handleTimeUpdate);
                            return;
                        }
                    }
                }
            }
        }
        // 查本地缓存
        if (!state.adTime){
            const result = getStoredAdTime(bvNumber);
            if (result) {
                debuglog('查询本地缓存')
                if (result ==="noAd") {
                    log(bvNumber, '非广告视频，跳过');
                    //停止观察器
                    //if (state.videoAreaObserver) state.videoAreaObserver.disconnect();
                    state.noAd = true;
                    return;
                }
                log('使用本地缓存时间戳', result.adTime);
                monitorTimestamp(bvNumber, result.adTime, result.source);
                return;
            }
            // 无数据，尝试调用 AI
            const dataTimestamp = await trySubtitlesAI(bvNumber)
            if (dataTimestamp) {
                monitorTimestamp(bvNumber, dataTimestamp, aiSelect.value);
            }
        }
    }

    async function trySubtitlesAI(bvNumber) {
        const commentAnalysis = checkComments();
        if (commentAnalysis.hasAd === true) {
            if (!state.hasProcessedPopup) {
                state.commentText = commentAnalysis.commentText;
                debuglog('【评论区发现广告，尝试调用AI】：\n', state.commentText);
                return await handleAIHelper();
            }
        } else if (commentAnalysis.hasAd === undefined) {
            return null;
        }
        else {
            log('评论区检查完毕，未发现广告线索') //将此视频标记为无广告');
            /*// false
            const data = JSON.parse(localStorage.getItem(bvNumber) || '{}');
            data.noAd = true;
            localStorage.setItem(bvNumber, JSON.stringify(data));
            state.noAd = true;
            stopDanmakuObservation();
            return null;
            */
        }
    }

    async function waitForSubtitlesAndExtract(popupBody) {
        const bvNumber = getBVNumber();
        if (!bvNumber) return null;

        const noTips = popupBody.querySelector('._EmptyTips_2jiok_17');
        if (noTips && noTips.textContent.includes('暂无AI字幕')) {
            debuglog('本视频暂无 AI 字幕');
            //if (state.videoAreaObserver) state.videoAreaObserver.disconnect();
            closePopup();
            return null;
        }

        const subtitles = popupBody.querySelectorAll('._Part_1iu0q_16');
        if (subtitles.length > 0 && !state.hasExtractedSubtitles) {
            state.hasExtractedSubtitles = true;
            const filtered = extractSubtitles(popupBody);
            debuglog(`提取字幕条数：${filtered.length}`);
            const dataTimestamp = await sendSubtitlesToAI(bvNumber, filtered);
            if (dataTimestamp) {
                state.adTime = dataTimestamp;
                storeAdTime(bvNumber, dataTimestamp, 'kimi');
                return dataTimestamp;
            }
            return null;
        } else {
            await new Promise(r => setTimeout(r, 1000));
            return await waitForSubtitlesAndExtract(popupBody);
        }
    }

    function monitorTimestamp(bvNumber, dataTimestamp, source) {
        if (!dataTimestamp || typeof dataTimestamp !== 'object' || !dataTimestamp.start || !dataTimestamp.end) {
            console.warn("无效时间戳，跳过", dataTimestamp);
            return;
        }
        state.adTime = dataTimestamp;
        const timestamp_range = `${dataTimestamp.start} - ${dataTimestamp.end}`;
        const duplicateCount = countIdenticalTimestamps(state.cloudAdTimes, timestamp_range);
        if (duplicateCount >= 2) {
            log(`云端已有 ${duplicateCount} 条相同时间戳，跳过上传`, timestamp_range);
            return;
        }
        if (!state.uploaded) {
            state.uploaded = true;
            debuglog('尝试共享时间戳', timestamp_range, source);
            //无需等待结果，不用异步模式
            sendAdTimeDataToSupabase(bvNumber, timestamp_range, source);
        }
        state.video.addEventListener('timeupdate', handleTimeUpdate);
    }

    function countIdenticalTimestamps(cloudAdTimes, timestamp_range) {
        if (!Array.isArray(cloudAdTimes)) return 0;
        return cloudAdTimes.filter(entry => entry.timestamp_range === timestamp_range).length;
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



    //------------------------------------------------
    async function handleAIHelper() {
        if (state.hasProcessedPopup) return null;

        const popupBody = document.querySelector('._Body_196qs_116');
        if (popupBody) {
            debuglog('AI 小助手窗口已弹出');
            state.hasProcessedPopup = true;
            return await processPopupContent(popupBody); // 返回时间戳
        }

        const button = document.querySelector('.video-ai-assistant');
        if (button) {
            debuglog('点击 AI 小助手按钮');
            button.click();
        }

        await new Promise(resolve => setTimeout(resolve, 1000));
        return await handleAIHelper(); // 递归轮询
    }

    function closePopup() {
        const closeButton = document.querySelector('._CloseBtn_196qs_87');
        if (closeButton) closeButton.click();
    }

    // 提取评论区文本并检测广告
    function checkComments() {
        let hasAd
        const commentsContainer = document.querySelector('#commentapp > bili-comments');
        if (!commentsContainer || !commentsContainer.shadowRoot) {
            debuglog("🛻尚未加载评论区容器");
            return { hasAd, commentText: "" };
        }

        const thread = commentsContainer.shadowRoot.querySelector('bili-comment-thread-renderer');
        if (!thread || !thread.shadowRoot) {
            return { hasAd, commentText: "" };
        }

        const commentRenderer = thread.shadowRoot.querySelector('#comment');
        if (!commentRenderer || !commentRenderer.shadowRoot) {
            return { hasAd, commentText: "" };
        }

        const richText = commentRenderer.shadowRoot.querySelector('#content > bili-rich-text');
        if (!richText || !richText.shadowRoot) {
            return { hasAd, commentText: "" };
        }

        const contentsElement = richText.shadowRoot.querySelector('#contents');
        if (!contentsElement) {
            return { hasAd, commentText: "" };
        }

        //有评论区了
        const commentText = contentsElement.textContent.trim();
        const links = contentsElement.querySelectorAll('a');
        for (const link of links) {
            const href = link.getAttribute('href');
            if (href && biliAdWordsConfig.biliAdLinks.some(blocked => href.includes(blocked))) {
                hasAd = true;
                break;
            }
        }

        if (hasAd === undefined) {
            const matches = commentText.match(keywordRegex);
            if (matches) {
                if (matches.length === 1 && matches[0] === '评论') {
                    hasAd = false;
                } else {
                    hasAd = true;
                }
            } else {
                hasAd = false;
            }
        }

        return { hasAd, commentText };
    }

    async function processPopupContent(popupBody) {
        const tabItems = popupBody.querySelectorAll('._Tabs_krx6h_1 ._TabItem_krx6h_8');
        if (!tabItems) return null;

        for (const tab of tabItems) {
            const label = tab.querySelector('._Label_krx6h_18');
            if (label && label.textContent.trim() === '字幕列表') {
                const isActive = tab.classList.contains('_Active_krx6h_36');
                if (!isActive) {
                    tab.click();
                    debuglog('点击字幕列表选项卡');
                    await new Promise(r => setTimeout(r, 2000));
                } else {
                    debuglog('字幕列表选项卡已激活');
                }
                return await waitForSubtitlesAndExtract(popupBody);
            }
        }

        debuglog('未找到字幕列表选项卡');
        return null;
    }


    //// 保存字幕到本地（仅限未下载）
    function trySaveSubtitles(subtitleArray) {
        const bvNumber = getBVNumber();
        const data = JSON.parse(localStorage.getItem(bvNumber) || '{}');
        if (!data.isdownloaded && Debug) {
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
        const maxSubtitles = 200;
        debuglog(`字幕条数：${subtitleArray.length}，尝试本地筛选广告片段...`);

        // 1. 提取关键词匹配的时间点（秒）+ 保留原始字幕对象
        const keywordMatches = subtitleObjects
        .map(obj => ({ sec: timeToSeconds(obj.time), obj }))
        .filter(entry => keywordRegex.test(entry.obj.content));

        if (keywordMatches.length === 0) {
            if (subtitleArray.length > maxSubtitles) {
                log(`未发现广告关键词，提取中间的${maxSubtitles}条`);
                const start = Math.floor((subtitleArray.length - maxSubtitles) / 2);
                return subtitleArray.slice(start, start + maxSubtitles);
            } else {
                //条数少，原样返回
                return subtitleArray
            }
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
                const match = entry.obj.content.match(keywordRegex);
                return `${formatTime(entry.sec)} ${match ? match[0] : ''}`;
            });
            debuglog(`广告词Block-${index + 1}: [${segmentInfo.join(', ')}]`);
        });

        // 4. 找到关键词数量最多的一段（你也可以选择最密集的段）
        const bestSegment = segments.reduce((a, b) => (a.length >= b.length ? a : b));
        const start = bestSegment[0].sec
        const end = bestSegment[bestSegment.length - 1].sec
        const ext = Math.max(10, 120 - (end - start) / 2);
        const minTime = Math.max(0, start - ext);
        const maxTime = end + ext;
        debuglog("疑似广告区域（包含扩展）", formatTime(minTime)+' - '+formatTime(maxTime));

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
        debuglog('开始提取字幕');
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
        debuglog(`字幕已保存到本地文件 ${fileName}`);
    }

    //公共AI服务
    async function callPublicAIService({
        platform = cloudPlatformService,
        bv=getBVNumber(),
        subtitles,
        user_id = getOrCreateUserId(),
        UP_id = state.upid || getUpid() || 'unknown'
    }) {
        log('用户没填入有效 API Key，使用公共服务器');
        let endpoint;

        if (platform === 'vercel') {
            endpoint = 'https://biliadskip.vercel.app/api/analyze';
        } else {
            endpoint = 'https://akoaopeqigjwpcksqdyf.supabase.co/functions/v1/publicAI';
        }

        const body = { bv, subtitles, user_id, UP_id };

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
            log(`${platform} AI 返回结果：`, result);

            return result.timestamp_Obj;

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
            log('用户未配置apikey，调用公共AI服务')
            const timestamp_Obj = await callPublicAIService({ platform: cloudPlatformService, bvNumber, subtitles});
            return timestamp_Obj;
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
                    content: '你是一个电商专家，识别广告时间段'
                },
                {
                    role: 'user',
                    content: `分析以下字幕，告诉我广告部分的起止时间戳，若未发现广告直接回复“无广告”。
                 广告部分一般不低于30秒，也有例外。如果你发现多段广告，回复我最像商业合作的那一段。
                 当博主突然话风一转从视频话题转移到本人如何，将这部分尝试导入广告的部分也看做广告。
                 如果我发你的字幕时间戳不是从00:00开始的，说明发给你的是经我初筛过的疑似广告部分。
                 将最后一条广告字幕接下来的下一条正常字幕的时间减去1s作为结束时间戳。
                 发现广告的话仅回复广告时间戳和品牌（如果有的话）+产品名称，不要回复其他内容。。
                 返回格式：\n广告开始 xx:xx, 广告结束 xx:xx ，产品：xx\n\n${subtitles.join('\n')}\n\n
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
                    console.warn(`错误 401，用户的API Key 无效，调用公共AI服务`);
                    const timestamp_Obj = await callPublicAIService({ platform: cloudPlatformService, bvNumber, subtitles});
                    return timestamp_Obj;
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
                const dataTimestamp = extractTimestampFromString(aiResponse);
                if (dataTimestamp) {
                    log(`提取到时间戳:  ${dataTimestamp.start}, ${dataTimestamp.end}`)
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

    function extractTimestampFromString(content) {
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

    function getUpid() {
        const firstUpCard = document.querySelector('.membersinfo-upcard-wrap .staff-name');
        if (firstUpCard) {
            return firstUpCard.textContent.trim();
        }
        const singleUp = document.querySelector('.up-detail .up-detail-top .up-name');
        if (!singleUp) return null;

        const clone = singleUp.cloneNode(true);
        clone.querySelectorAll('span').forEach(span => span.remove());
        return clone.textContent.trim();
    }

    function isUpOfficialOrg() {
        // UP是否为蓝色闪电认证
        const upInfoLeft = document.querySelector('.up-info--left');
        if (upInfoLeft) {
            const avatarIcon = upInfoLeft.querySelector('.up-avatar-wrap .bili-avatar .bili-avatar-icon.bili-avatar-right-icon');
            return avatarIcon ? avatarIcon.classList.contains('bili-avatar-icon-business') : false;
        }
        return false;
    }

    function getBVNumber() {
        const url = new URL(window.location.href);
        const path = url.pathname;
        const match = path.match(/\/video\/(BV\w+)/);
        return match ? match[1] : null;
    }

    function storeAdTime(bvNumber, adTimestamp, source) {
        const data = JSON.parse(localStorage.getItem(bvNumber) || '{}')
        if (!data.timestamps || typeof data.timestamps !== 'object' || Array.isArray(data.timestamps)) {
            data.timestamps = {};
        }
        data.timestamps[source] = {...adTimestamp };
        localStorage.setItem(bvNumber, JSON.stringify(data));
        log(`[${bvNumber}] 广告时间已存储，来源：${source}，${adTimestamp.start} - ${adTimestamp.end}`);
    }

    function getStoredAdTime(bvNumber) {
        const raw = localStorage.getItem(bvNumber);
        if (!raw) {
            state.adTime = null;
            return null;
        }

        let data;
        try {
            data = JSON.parse(raw);
        } catch {
            state.adTime = null;
            return null;
        }

        if (data.noAd) {
            state.adTime = null;
            return 'noAd';
        }

        const tsObj = data.timestamps;
        if (!tsObj || typeof tsObj !== 'object') {
            state.adTime = null;
            return null;
        }

        const keys = Object.keys(tsObj);
        if (keys.length === 0) {
            state.adTime = null;
            return null;
        }

        for (const key of keys) {
            const lk = key.toLowerCase();
            if (lk !== 'danmaku' && lk !== 'unknown') {
                const ts = tsObj[key];
                if (ts?.start && ts?.end) {
                    state.adTime = ts;
                    return { adTime: ts, source: key };
                }
            }
        }

        if (tsObj.Danmaku?.start && tsObj.Danmaku?.end) {
            state.adTime = tsObj.Danmaku;
            return { adTime: tsObj.Danmaku, source: 'Danmaku' };
        }

        for (const key of keys) {
            const ts = tsObj[key];
            if (ts?.start && ts?.end) {
                state.adTime = ts;
                return { adTime: ts, source: key };
            }
        }

        state.adTime = null;
        return null;
    }

    function printAllStoreddataTimestamp() {
        log('--打印已存储视频广告时间戳列表--');
        const keys = Object.keys(localStorage);
        const bvNumberKeys = keys.filter(key => key.startsWith('BV1'));

        if (bvNumberKeys.length === 0) {
            log('没有找到任何保存的广告时间戳');
            return;
        }

        bvNumberKeys.forEach(bvNumber => {
            const data = JSON.parse(localStorage.getItem(bvNumber) || '{}');
            if (data.timestamps) {
                for (const [source, ts] of Object.entries(data.timestamps)) {
                    log(`视频 ${bvNumber} [${source}] : ${ts.start} - ${ts.end}`);
                }
            }
        });
    }

    function log(...args) {
        console.log('[B站AI跳广告] ', ...args);
    }

    function debuglog(...args) {
        if (Debug) { log(...args) }
    }
    //////////////////////////////////////////////////////////////////////

    // 创建配置界面
    const configContainer = document.createElement('div');
    configContainer.id = 'kimiConfigContainer';
    configContainer.style.cssText = ` position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 500px; padding: 20px; background: #fff;
    border: 1px solid #ccc; border-radius: 10px; z-index: 10000; display: none; font-size: 16px; box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2); `;

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
        { value: 'kimi', text: 'Kimi', apiUrl: 'https://api.moonshot.cn/v1/chat/completions', model: 'moonshot-v1-32k' },
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
    cancelButton.textContent = '关闭界面';
    cancelButton.id = 'kimiCancelConfig';

    // 将两个按钮添加到容器中
    buttonContainer.appendChild(saveButton);
    buttonContainer.appendChild(cancelButton);

    // 配置界面的显示与隐藏
    function showConfig() {
        configContainer.style.display = 'block';
    }

    function hideAIConfig() {
        configContainer.style.display = 'none';
    }

    // 加载本地存储的配置
    function loadAIConfig() {
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
    function saveAIConfig() {
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
        hideAIConfig();
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
    loadAIConfig();
    saveButton.addEventListener('click', saveAIConfig);
    cancelButton.addEventListener('click', hideAIConfig);

    //==========================================

    // 手动添加本页广告时间戳
    function adddataTimestamptamp() {
        const bvNumber = getBVNumber();
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
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);`;

        const dataTimestamptampTitle = document.createElement('h4');
        dataTimestamptampTitle.textContent = `手动配置本页广告时间戳`;
        dataTimestamptampTitle.style.cssText = 'text-align: center; margin-bottom: 20px; font-weight: bold;';
        dataTimestamptampContainer.appendChild(dataTimestamptampTitle);

        const stored = getStoredAdTime(bvNumber);
        const start = stored?.adTime?.start || '';
        const end = stored?.adTime?.end || '';

        const { row: startTimeRow, input: startTimeInput } = createTimeInputRow('广告起始', 'kimiStartTime', start);
        const { row: endTimeRow, input: endTimeInput } = createTimeInputRow('广告结束', 'kimiEndTime', end);
        dataTimestamptampContainer.appendChild(startTimeRow);
        dataTimestamptampContainer.appendChild(endTimeRow);

        function createTimeInputRow(labelText, inputId, storedValue) {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; align-items: center; margin-bottom: 10px;';

            const label = document.createElement('label');
            label.textContent = labelText;
            label.style.cssText = 'width: 70px; text-align: right; margin-right: 10px; margin-left: 50px;';
            row.appendChild(label);

            const wrapper = document.createElement('div');
            wrapper.style.cssText = 'position: relative; flex: 1.0; max-width: 240px;';

            const input = document.createElement('input');
            input.type = 'text';
            input.id = inputId;
            input.placeholder = '格式 00:00';
            input.style.cssText = 'width: 100%; box-sizing: border-box; padding-left: 3px;';
            if (storedValue) input.value = storedValue;
            wrapper.appendChild(input);

            if (storedValue) {
                const hintSpan = document.createElement('span');
                hintSpan.textContent = '(读取自本地存储)';
                hintSpan.style.cssText = `position: absolute; right: 6px; font-size: 12px; opacity: 0.75; pointer-events: none;`;
                wrapper.appendChild(hintSpan);
            }

            row.appendChild(wrapper);

            // “跳至此处”按钮
            const result = getStoredAdTime(bvNumber);
            if (result && result.adTime) {
                const jumpBtn = document.createElement('button');
                jumpBtn.textContent = '跳至此处';
                jumpBtn.style.cssText = `
                margin-left: 10px;
                padding: 4px 8px;
                font-size: 12px;
                cursor: pointer`;

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
            }
            return { row, input };
        }

        // 按钮容器
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = 'display: flex; justify-content: center; align-items: center; margin-top: 20px;';

        // 保存按钮
        const saveTimestampButton = document.createElement('button');
        saveTimestampButton.textContent = '保存配置';
        saveTimestampButton.id = 'kimiSaveTimestamp';
        saveTimestampButton.style.cssText = 'margin-right: 10px;';
        saveTimestampButton.onclick = () => {
            const startTime = startTimeInput.value.trim();
            const endTime = endTimeInput.value.trim();
            if (startTime && endTime) {
                // 检查时间格式是否正确
                const timeRegex = /^(\d{1,2}:\d{2}(:\d{2})?)$/;
                if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
                    alert('请输入正确的时间格式（例如：05:30 或 01:30:45）');
                    return;
                }

                const dataToStore = JSON.parse(localStorage.getItem(bvNumber) || '{}');
                if (dataToStore.noAd) {
                    delete dataToStore.noAd;
                }
                if (!dataToStore.timestamps) {
                    dataToStore.timestamps = {};
                }
                const dataTimestamp = { start: startTime, end: endTime };
                dataToStore.timestamps.kimi = dataTimestamp;
                // 保存广告时间戳到本地存储
                localStorage.setItem(bvNumber, JSON.stringify(dataToStore));
                log(`[${bvNumber}] 广告时间已手动存储，${dataTimestamp.start} - ${dataTimestamp.end}`);

                const timestamp_range = `${dataTimestamp.start} - ${dataTimestamp.end}`;
                //用户手动输入的时间戳，主动上传
                sendAdTimeDataToSupabase(bvNumber, timestamp_range, 'kimi');

                state.adTime = dataTimestamp;
                state.video = null;
                document.body.removeChild(dataTimestamptampContainer);
            } else {
                alert('请输入完整的广告时间戳！');
            }
        };

        buttonContainer.appendChild(saveTimestampButton);
        dataTimestamptampContainer.appendChild(buttonContainer);

        function clearUI(){
            state.adTime = null;
            document.getElementById('kimiStartTime').value = '';
            document.getElementById('kimiEndTime').value = '';
            if (state.video) {
                state.video.removeEventListener('timeupdate', handleTimeUpdate);
                state.video = null;
            }
            document.body.removeChild(dataTimestamptampContainer);
        }

        //无广告”按钮 
        const noAdBtn = document.createElement('button');
        noAdBtn.style.marginRight = '10px';

        const currentData = JSON.parse(localStorage.getItem(bvNumber) || '{}');

        if (currentData.noAd === true) {
            noAdBtn.textContent = '该视频已标记无广 (点击取消)';
            noAdBtn.style.color = '#e67e22'; // 使用醒目的颜色提示
            noAdBtn.onclick = () => {
                delete currentData.noAd; // 从数据对象中删除 noAd 标记
                localStorage.setItem(bvNumber, JSON.stringify(currentData));
                log(`已取消 ${bvNumber} 的无广告标记`);
                alert('已取消标记！');
                document.body.removeChild(dataTimestamptampContainer);
            };
        } else {
            noAdBtn.textContent = '标记该页无广';
            noAdBtn.style.color = '#27ae60';
            noAdBtn.onclick = () => {
                currentData.noAd = true; // 标记无广告
                localStorage.setItem(bvNumber, JSON.stringify(currentData));
                log(`已标记 ${bvNumber} 为无广告视频`);
                alert('已成功标记为无广告！');
                clearUI(); // 使用 clearUI 来关闭窗口并重置状态
            };
        }
        buttonContainer.appendChild(noAdBtn);

        // “删除”按钮
        if (getStoredAdTime(bvNumber)) {
            const delBtn = document.createElement('button');
            delBtn.textContent = '删除该页记录';
            delBtn.style.marginRight = '10px';
            delBtn.style.color = '#e74c3c';
            delBtn.onclick = () => {
                localStorage.removeItem(bvNumber);
                log(`已清除 ${bvNumber} 本地缓存数据`);
                clearUI();
            };
            buttonContainer.appendChild(delBtn);
        }

        // 关闭按钮
        const cancelTimestampButton = document.createElement('button');
        cancelTimestampButton.textContent = '关闭界面';
        cancelTimestampButton.id = 'kimiCancelTimestamp';
        cancelTimestampButton.onclick = () => {
            document.body.removeChild(dataTimestamptampContainer);
        };
        buttonContainer.appendChild(cancelTimestampButton);

        //插入按钮容器
        document.body.appendChild(dataTimestamptampContainer);
    }

    //————————UP白名单————————
    const oldList = localStorage.getItem('whiteList');
    if (oldList) {localStorage.setItem('biliUpWhiteList', oldList); localStorage.removeItem('whiteList');}

    const whiteList = JSON.parse(localStorage.getItem('biliUpWhiteList')) || [];
    // 添加到白名单
    function addToWhiteList(upId) {
        if (!whiteList.includes(upId)) {
            whiteList.push(upId);
            localStorage.setItem('biliUpWhiteList', JSON.stringify(whiteList));
            updateWhiteListDisplay(); // 更新显示
        }
    }

    // 从白名单中移除
    function removeFromWhiteList(upId) {
        const index = whiteList.indexOf(upId);
        if (index !== -1) {
            whiteList.splice(index, 1);
            localStorage.setItem('biliUpWhiteList', JSON.stringify(whiteList));
            updateWhiteListDisplay(); // 更新显示
        }
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
        const UpWhiteListContainer = document.createElement('div');
        UpWhiteListContainer.id = 'kimiUpWhiteListContainer';
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

        const Title = document.createElement('h4');
        Title.textContent = `手动管理白名单（不跳过广告）`;
        Title.style.cssText = 'text-align: center; margin-bottom: 20px;';
        UpWhiteListContainer.appendChild(Title);

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
        UpWhiteListContainer.appendChild(addUpRow);

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

        UpWhiteListContainer.appendChild(removeUpRow);
        // 白名单列表显示区域
        const listDiv = document.createElement('div');
        listDiv.id = 'whiteListDisplay';
        listDiv.style.cssText = `
        text-align: center;
        color: #4CAF50;
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

        // 完成按钮
        const finishButton = document.createElement('button');
        finishButton.textContent = '完成';
        finishButton.style.cssText = 'padding: 0 10px; margin: 0 5px;';
        finishButton.addEventListener('click', () => {
            document.body.removeChild(UpWhiteListContainer);
        });

        const addUpButton = document.createElement('button');
        addUpButton.textContent = '添加当前页UP';
        addUpButton.style.cssText = 'padding: 0 10px; margin: 0 5px;';
        addUpButton.addEventListener('click', () =>{
            const upId = getUpid();
            if (upId) { addToWhiteList(upId );}
        });

        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = 'display: flex; justify-content: center; margin: 10px 0;';

        buttonContainer.appendChild(addUpButton);
        buttonContainer.appendChild(finishButton);

        UpWhiteListContainer.appendChild(buttonContainer);

        document.body.appendChild(UpWhiteListContainer);
    }

    // 注册菜单命令
    GM_registerMenuCommand("1-管理时间戳", adddataTimestamptamp);
    GM_registerMenuCommand("2-UP白名单", WhiteListMenu);
    GM_registerMenuCommand("3-配置脚本AI（可以忽略，脚本自带公共AI）", showConfig);

    //----------------------------整合弹幕脚本-------------------------------
    const timeRegexList = [
        { regex: /\b(\d{1,2})[:：]([0-5]\d)\b/, isFuzzy: false }, // 5:14
        { regex: /(\d{1,2}|[一二三四五六七八九十]{1,3})分(\d{1,2}|[零一二三四五六七八九十]{1,3})/, isFuzzy: false },
        { regex: /(\d{1,2})\.(\d{1,2})[郎朗]/, isFuzzy: false },
        { regex: /(?<!\d)(?:(\d{2})\.(\d{1,2})|(\d{1,2})\.(\d{2}))(?![\d郎君侠秒分：wk+＋])/i, isFuzzy: true } // 模糊时间戳：纯数字 5.14，排除1.9这种
    ];
    const cnNumMap = {
        "零": 0, "一": 1, "二": 2,"两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10
    };

    function parseNumber(char) {
        return cnNumMap[char] || parseInt(char) || 0;
    }

    function parseChineseNumber(ch) {
        if (ch.length === 1) return parseNumber(ch);
        if (ch.length === 2) return (ch[1] === "十") ? parseNumber(ch[0]) * 10 : (10 + parseNumber(ch[1]));
        if (ch.length === 3 && ch[1] === "十") return parseNumber(ch[0]) * 10 + parseNumber(ch[2]);
        return 0;
    }

    const pendingDanmaku = [];
    const timestampCounter = new Map();
    const processedTimestamps = new Map();
    const fuzzyCandidates = []; // { timestamp, timeAdded }

    const TIME_GROUP_THRESHOLD = 10;
    const FUZZY_TIMEOUT = 10;
    const MIN_JUMP_INTERVAL = 5; //跳转冷静期，防止频繁跳转
    const MIN_COUNT_TO_LOG = 2;
    const DanmakuAdtimeSaved = {};

    function extractTimestamps(text) {
        if (/[百千万亿wk]/i.test(text)) return null;
        const cleanText = text.replace(/\s+/g, '');

        for (let i = 0; i < timeRegexList.length; i++) {
            const { regex, isFuzzy } = timeRegexList[i];
            const match = regex.exec(cleanText);
            if (match) {
                const parts = [match[1], match[2]];
                const isChinese = parts.map(p => /[一二三四五六七八九十]/.test(p));
                const values = parts.map((p, idx) => isChinese[idx] ? parseChineseNumber(p) : parseInt(p) || 0);
                const ts = values[0] * 60 + values[1];
                const isAdTs = /[郎朗君侠猜秒谢]/.test(text) || (isChinese[0] !== isChinese[1])
                if (!isNaN(ts) && ts >= 60) { //限制广告时间戳位置在01:00之后
                    return {
                        timestamp: ts,
                        isAdTs,
                        isFuzzy
                    };
                }
            }
        }
        return null;
    }

    function recordTimestamp(ts) {
        for (const [existingTs, count] of timestampCounter.entries()) {
            if (Math.abs(existingTs - ts) <= TIME_GROUP_THRESHOLD) {
                const newKey = Math.min(existingTs, ts);
                timestampCounter.set(newKey, count + 1);
                if (existingTs !== newKey) timestampCounter.delete(existingTs);
                return;
            }
        }
        timestampCounter.set(ts, 1);
    }

    function processPendingDanmaku() {
        // --- 核心修改：添加播放状态检查 ---
        if (!state.isVideoPlaying) return;
        if (state.noAd) return;
        if (state.adTime) {
            stopDanmakuObservation();
            return;
        }
        const now = Date.now();
        // 先记录本轮新的明确时间戳（用于模糊匹配）
        for (const { text, timestamp: ts, isAdTs } of pendingDanmaku) {
            if (isAdTs) {
                timestampCounter.set(ts, MIN_COUNT_TO_LOG);
            } else {
                recordTimestamp(ts);
            }
        }

        // 处理模糊候选
        for (let i = fuzzyCandidates.length - 1; i >= 0; i--) {
            if (now - fuzzyCandidates[i].timeAdded >= FUZZY_TIMEOUT*1000) {
                debuglog('[模糊丢弃]', formatTime(fuzzyCandidates[i].timestamp));
                fuzzyCandidates.splice(i, 1);
            }
        }

        for (let i = fuzzyCandidates.length - 1; i >= 0; i--) {
            const fuzzy = fuzzyCandidates[i];
            for (const ts of timestampCounter.keys()) {
                if (Math.abs(fuzzy.timestamp - ts) <= TIME_GROUP_THRESHOLD) {
                    debuglog('[模糊转正]', fuzzy.timestamp, '因匹配到', ts);
                    recordTimestamp(fuzzy.timestamp);
                    fuzzyCandidates.splice(i, 1);
                    break;
                }
            }
        }
        pendingDanmaku.length = 0;
        handleTimeUpdate();
        timestampCounter.clear();
    }

    let danmakuObserver = null;
    let danmakuInterval = null;

    function handleDanmakuMutations(mutationsList) {
        if (isUpOfficialOrg()) {
            if (danmakuInterval) {
                stopDanmakuObservation();
            }
            return;
        }

        for (const mutation of mutationsList) {
            for (const node of mutation.addedNodes) {
                if (node._danmakuHandled) continue;
                node._danmakuHandled = true;
                const text = node.textContent.trim();
                if (text.length === 0 || text === '9麤') continue;
                //log('[弹幕节点识别]', text, 'from', node);
                const result = extractTimestamps(text);
                if (result) {
                    debuglog('📌识别时间戳弹幕:', text, formatTime(result.timestamp), result.isFuzzy ? '[疑似]' : '[确认]');
                    if (result.isFuzzy) {
                        fuzzyCandidates.push({ timestamp: result.timestamp, timeAdded: Date.now() });
                    } else {
                        pendingDanmaku.push({
                            text,
                            timestamp: result.timestamp,
                            isAdTs: result.isAdTs
                        });
                    }
                }
            }
        }
    }

    function stopDanmakuObservation() {
        log('停止弹幕观察');
        if (danmakuObserver) {
            danmakuObserver.disconnect();
            danmakuObserver = null;
        }
        if (danmakuInterval) {
            clearInterval(danmakuInterval);
            danmakuInterval = null;
        }
    }

    function ObserveDanmaku(container) {
        debuglog('启动，弹幕容器绑定');
        danmakuObserver = new MutationObserver(handleDanmakuMutations);
        danmakuObserver.observe(container, { childList: true, subtree: true });
        danmakuInterval = setInterval(()=>{
            debuglog("定时器执行 - danmakuInterval");
            processPendingDanmaku();
        }, 1500);
    }

    function startObserveDanmakuOnceReady() {
        const check = setInterval(() => {
            const container = document.querySelector('div.bpx-player-render-dm-wrap > div.bpx-player-dm-mask-wrap > div.bpx-player-row-dm-wrap');
            if (container) {
                clearInterval(check);
                if (!isUpOfficialOrg()) {
                    ObserveDanmaku(container);
                }
            }
        }, 1000);
    }

    function videoEnded() {
        console.log('视频播放已结束。');
        stopDanmakuObservation();
    }

    const defaultConfig = {
        keywordStr: `淘宝|京东|天猫|补贴|折扣|福利|专属|下单|运(费?)险|[领惠叠]券|[低特好底保降差性]价`,
        biliAdLinks: ['taobao.com', 'tb.cn', 'jd.com', 'pinduoduo.com','zhuanzhuan.com', 'mall.bilibili.com', 'gaoneng.bilibili.com'],
        time: 0
    };

    let biliAdWordsConfig, keywordRegex


    async function initPageObserver() {
        // 使用轮询来等待播放器区域出现
        const videoArea = await new Promise(resolve => {
            const interval = setInterval(() => {
                const area = document.querySelector('.bpx-player-video-area');
                if (area) {
                    clearInterval(interval);
                    resolve(area);
                }
            }, 1000); // 每500毫秒检查一次
        });

        // 找到区域后，再轮询等待 video 标签出现
        const video = await new Promise(resolve => {
            const interval = setInterval(() => {
                const vid = videoArea.querySelector('video');
                if (vid) {
                    clearInterval(interval);
                    resolve(vid);
                }
            }, 1000);
        });

        // --- 成功找到 video 元素后，执行所有绑定逻辑 ---
        log('✅ 播放器和视频元素加载成功，开始绑定事件');
        state.video = video;
        state.isVideoPlaying = !video.paused;
        log(`同步初始视频状态：isVideoPlaying = ${state.isVideoPlaying}`);

        // 启动弹幕监听
        startObserveDanmakuOnceReady();

        // 绑定一个内部的、针对视频区域的观察器
        const throttledHandler = throttle(handlePageChanges, 750);
        if (state.videoAreaObserver) state.videoAreaObserver.disconnect();
        state.videoAreaObserver = new MutationObserver(() => {
            throttledHandler();
        });
        state.videoAreaObserver.observe(videoArea, { childList: true, subtree: true });

        const handlePlay = () => {
            log('▶️ 视频播放中，恢复监控');
            state.isVideoPlaying = true;

            const isTaskConcluded = state.adTime || state.noAd || whiteList.includes(state.upid);
            if (!isTaskConcluded && video.currentTime < 1 && !danmakuInterval) {
                log('检测到视频从头播放，且广告任务未完成，尝试重建弹幕观察器...');
                startObserveDanmakuOnceReady();
            }
        };

        const handlePause = () => {
            log('⏸️ 视频已暂停，暂停监控');
            state.isVideoPlaying = false;
        };

        // 移除旧监听防止重复绑定
        video.removeEventListener('play', handlePlay);
        video.removeEventListener('pause', handlePause);

        video.addEventListener('play', handlePlay);
        video.addEventListener('pause', handlePause);
        // --- 核心修改结束 ---

        // 统一在这里绑定事件监听器
        video.removeEventListener('ended', videoEnded);
        video.addEventListener('ended', videoEnded);

        // 如果已有广告时间，绑定 timeupdate
        if (state.adTime) {
            video.removeEventListener('timeupdate', handleTimeUpdate);
            video.addEventListener('timeupdate', handleTimeUpdate);
        }
    }

    function setupNavigationObserver() {
        const observerCallback = (mutationsList, observer) => {
            const throttledHandler = throttle(() => {
                const currentBV = getBVNumber();
                if (currentBV && currentBV !== state.currentBV) {
                    handlePageChanges(observer);
                } else if (currentBV && !state.video && !state.isHandling) {
                    handlePageChanges(observer);
                }
            }, 1000);
            throttledHandler();
        };
        const mainObserver = new MutationObserver(observerCallback);
        mainObserver.observe(document.body, {
            childList: true,
            subtree: true
        });
        log('✅ 主导航观察器已启动');
    }

    async function initApp() {
        console.log('🔄 开始加载配置...');
        await getAdWordsConfig(defaultConfig);
        setupNavigationObserver();
    }
    // 启动
    initApp().catch(console.error);
})();
