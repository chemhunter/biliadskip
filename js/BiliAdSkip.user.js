// ==UserScript==
// @name             BiliAdSkipLite
// @namespace    BiliAdSkip
// @description  通过分析置顶评论、字幕、弹幕，获取视频广告时间戳，自动跳过广告（轻量版）
// @version       2.33-lite
// @author       BiliAdSkip
// @match        https://www.bilibili.com/*
// @match        https://space.bilibili.com/*
// @match        https://t.bilibili.com/*
// @connect      cdn.jsdelivr.net
// @connect      raw.githubusercontent.com
// @connect      akoaopeqigjwpcksqdyf.supabase.co
// @connect      biliadskip.vercel.app
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_listValues
// @grant        GM_deleteValue
// @grant        GM_download
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @run-at       document-start
// @icon       https://i2.hdslb.com/bfs/emote/3087d273a78ccaff4bb1e9972e2ba2a7583c9f11.png
// @require      https://cdn.jsdelivr.net/npm/protobufjs@7.3.0/dist/protobuf.min.js
// @require      https://cdn.jsdelivr.net/npm/blueimp-md5@2.19.0/js/md5.min.js
// @noframes

// ==/UserScript==
(function() {
    'use strict';

    const SHOW_DEBUG_LOG = false;
    const SHOW_DEBUG_TIMEGAP = false;
    const FORCE_GIT_CONFIG = false;
    const FORCE_AI_ACTIVE = true;
    const DOWNLOAD_SUBTITLE_FILE = false;
    const SHORT_VIDEO_DURATION = 150;
    const ANALYZE_DNAMAKU = null;

    // 公共AI平台 supabase || vercel
    const cloudPlatformService = 'supabase';

    // --- 跟hookFetch 有关的全局变量
    const gState = {
        originalFetch: null,
        isFetchHooked: false,
        deviceFingerprint: null
    };

    // --- 全局变量定义 ---
    let biliAdWordsConfig, keywordRegex, whiteList;
    let logTime
    let subtitlePromiseResolver = null

    // --- 脚本运行中一些基础变量 ---
    const defaultState = {
        currentBV: null,
        adTime: null,
        video: null,
        isHandling: false,
        lastJumpTime: 0,
        commentText:'',
        bvCloudChecked: false,
        uploaded: false,
        upName: '',
        officialOrg: null,
        noAd: false,
        danmakuTimestampStore: {},
        isAIAnalysisInProgress: false,
        commentAnalysisResult: null,
    };

    const state = { ...defaultState };

    const defaultConfig = {
        keywordStr: `[淘某]宝|京东|天猫|美团|拼多|并夕|外卖|转转|补贴|折扣|福利|专属|下单|退款|免费|大促|[心快速]冲|运(费?)险|[领惠叠]券|[低底特好性差降保]价`,
        biliAdLinks: ['taobao.com', 'tb.cn', 'jd.com', 'pinduoduo.com','zhuanzhuan.com', 'mall.bilibili.com', 'gaoneng.bilibili.com', 'bilibili.com/cheese/', 'b23.tv/mall-'],
        noticeAudioBase64: null,
        time: 0
    };

    const publicAiPlatform ={
        vercel: 'https://biliadskip.vercel.app/api/analyze',
        supabase: 'https://akoaopeqigjwpcksqdyf.supabase.co/functions/v1/publicAI'
    }

    // --- 新增：全局数据缓存 ---
    const scriptCache = {
        mainAdDbKeys: [],
        noAdDbKeys: []
    };

    //protobuf库
    const { Root } = window.protobuf;

    const supabaseAnonKey = [
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
        'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFrb2FvcGVxaWdqd3Bja3NxZHlmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTQ0MDgwMzEsImV4cCI6MjA2OTk4NDAzMX0',
        '6JW6Gtescu5btG25b3en9w84ZbO40Z4fy3iUfWROIOM',
    ];

    function formatLogMessage(prefix, ...args) {
        if (typeof args[0] === 'string' && args[0].includes('%c')) {
            const formatStr = args[0];
            const styleArgs = args.slice(1);
            const cCount = (formatStr.match(/%c/g) || []).length;
            const filled = [...styleArgs];
            while (filled.length < cCount) {
                filled.push('color: red; background: #fff3cd; padding: 2px; font-weight: bold;');
            }
            return [prefix + formatStr, ...filled];
        } else {
            return [prefix, ...args];
        }
    }

    function log(...args) {
        logTime = Date.now();
        console.log(...formatLogMessage('[BiliAdSkip] ', ...args));
    }

    function debuglog(...args) {
        if (SHOW_DEBUG_LOG) {
            let logTimeGap = '';
            if (SHOW_DEBUG_TIMEGAP) {
                const now = Date.now();
                const gap = now - logTime;
                logTimeGap = (gap <= 5000 && gap >= 50) ? `[${gap}]` : '';
                logTime = now;
            }
            console.log(...formatLogMessage(`[BiliAdSkip][dbg]${logTimeGap}`, ...args));
        }
    }

    /** 随机延迟函数 (Promise封装) */
    const randomSleep = (averageTime, fluctuation = 0) => {
        const finalDelay = Math.floor(averageTime - fluctuation + Math.random() * fluctuation * 2);
        return new Promise(resolve => setTimeout(resolve, finalDelay));
    };

    /** 重置脚本的数据状态 */
    const resetState = () => {
        const isHandling_backup = state.isHandling;
        Object.assign(state, defaultState);
        state.isHandling = isHandling_backup;
        state.danmakuTimestampStore = {};
        log('状态已重置 (保留进程标志)');
    }


    // 查询云端，通过调用Edge Function
    async function fetchAdTimeDataFromCloud(bv) {
        log('⌛查询云端时间戳...');
        try {
            const url = "https://akoaopeqigjwpcksqdyf.supabase.co/functions/v1/biliadskipQuery";
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${supabaseAnonKey.join('.')}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ bv})
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`云函数响应错误: ${response.status} ${errorText}`);
            }
            const data = await response.json();
            if (!data || data.length === 0) {
                log(`❌ 云端无记录`);
                return null;
            }
            // log(`⏬ ${bv} 云端返回数据`, data);
            return data;
        } catch (error) {
            console.error(`❌ 调用接口异常:`, error.message);
            return null;
        }
    }


    // 上传共享数据到云端数据库 Supabase
    async function uploadAdTimeDataToCloud(bv, timestamp_range, source, NoAD = null) {
        try {
            const url = "https://akoaopeqigjwpcksqdyf.supabase.co/functions/v1/biliadskip";
            const upInfo = await getUpInfo();
            const dataBody = {
                bv,
                timestamp_range: NoAD ? null : timestamp_range,
                source,
                user_id: getOrCreateUserId(),
                up_id: state.upName || upInfo?.name || 'unknown',
                NoAD
            }

            const Resp = await fetch(url, {
                method: "POST",
                headers: {
                    'Authorization': `Bearer ${supabaseAnonKey.join('.')}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(dataBody)
            });

            if (!Resp.ok) {
                const errorText = await Resp.text();
                console.error("❎调用接口失败：", Resp.status, Resp.statusText, errorText);
                return { success: false, error: errorText };
            }

            log(`🆗已共享: ${timestamp_range || NoAD && 'noAd' }`);
            const biliadskipJson = await Resp.json();
            return { success: true, biliadskip_result: biliadskipJson };

        } catch (err) {
            console.error("❌调用接口异常：", err);
            return { success: false, error: err.message || err };
        }
    }


    // 绑定视频timeupdate事件的回调函数
    function handleTimeUpdate() {
        // 1. 基础状态检查
        if ((state.video && state.video.paused) || !state.video) return;

        // --- 2. 核心：只在 state.adTime 存在时，才执行监控 ---
        if (state.adTime) {
            const currentTime = state.video.currentTime;
            const duration = state.video.duration;
            const now = Date.now();
            const timeSinceLastJump = now - state.lastJumpTime;

            // 规则一：跳转抑制
            if (timeSinceLastJump < MIN_JUMP_INTERVAL * 1000) {
                return;
            }

            // 规则二：安全区检查
            const clampedEndZone = 15; //Math.max(15, Math.min(duration / 10, 90));
            const isSafeToJumpFrom = currentTime > 15 && currentTime < duration - clampedEndZone;

            // 规则三：时间段检查
            const start = timeToSeconds(state.adTime.start);
            const end = timeToSeconds(state.adTime.end);

            const isInAdSegment = currentTime >= start && currentTime <= end;

            // 【最终决策】
            if (isInAdSegment && isSafeToJumpFrom) {
                log(`timeUpdate: 执行广告跳转`);
                JumpAndShowNotice(state.video, start, end, now);
            }
        }
    }

    function JumpAndShowNotice(video, start, end, now) {
        log(` ⏩ 跳转 %c${formatTimeTenths(start)} --> ${formatTimeTenths(end)}`, 'color: #e77222; font-weight: bold;');
        video.currentTime = end;
        state.lastJumpTime = now;
        const container = document.querySelector('.bpx-player-video-wrap');
        if (!container) return;
        const box = document.createElement('div');
        box.innerText = `跳至 ⏩ ${formatTimeTenths(end)}`;
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
        playNoticeSound.play();
    }


    /** 一个完全自包含的音频播放模块。
                 * 负责管理音频上下文和缓冲区的生命周期。 */
    const playNoticeSound = (() => {
        let audioCtx = null;
        let audioBuffer = null;
        let isInitialized = false;

        async function initialize() {
            if (isInitialized) return;
            const base64String = biliAdWordsConfig.noticeAudioBase64;
            if (!base64String) {
                console.warn("未提供音频数据，音频模块将保持禁用。");
                isInitialized = true;
                return;
            }
            try {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                audioBuffer = await decodeAudioData(audioCtx, base64String);
                isInitialized = true;
                debuglog("🔊 音频模块初始化");
            } catch (e) {
                console.error("音频模块初始化失败:", e);
                isInitialized = true;
            }
        }

        return {
            play: async function() {
                await initialize();
                playDecodedAudio(audioCtx, audioBuffer);
            }
        };
    })();


    /**负责解码Base64音频数据。 */
    async function decodeAudioData(audioCtx, base64String) {
        try {
            const remainder = base64String.length % 4;
            if (remainder !== 0) {
                base64String += '='.repeat(4 - remainder);
            }

            const binaryString = window.atob(base64String);
            const arrayBuffer = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
                arrayBuffer[i] = binaryString.charCodeAt(i);
            }
            return await audioCtx.decodeAudioData(arrayBuffer.buffer);
        } catch (error) {
            console.error("❌ Base64 音频解码失败:", error);
            return null;
        }
    }


    /** 负责播放一个已解码的音频缓冲区。 */
    function playDecodedAudio(audioCtx, buffer) {
        if (!buffer || !audioCtx || audioCtx.state === 'closed') return;

        debuglog('🔊 播放跳转提示音...');
        const source = audioCtx.createBufferSource();
        source.buffer = buffer;
        source.connect(audioCtx.destination);
        source.start();
    }

    function getOrCreateUserId() {
        let userId = localStorage.getItem("biliadskip_random_user_id");
        if (!userId) {
            userId = generateRandomId(8);
            localStorage.setItem("biliadskip_random_user_id", userId);
        }
        return userId;
    }


    // 获取新广告时间戳提示音'咚咚'
    function playBeepSound(frequency = 1100) {
        const audioContext = new (window.AudioContext || window.webkitAudioContext)();
        const now = audioContext.currentTime;

        const oscillator = audioContext.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency, now);

        const gainNode = audioContext.createGain();
        gainNode.gain.setValueAtTime(0, now);

        oscillator.connect(gainNode);
        gainNode.connect(audioContext.destination);

        oscillator.start();

        gainNode.gain.setValueAtTime(0.5, now + 0.1);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.2);

        gainNode.gain.setValueAtTime(0.5, now + 0.4);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + 0.5);

        oscillator.stop(now + 0.6);
    }


    //随机用户id创建函数
    function generateRandomId(length) {
        const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
        let result = "";
        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }


    // 提前判断是否需要开启广告检测
    async function videoNeedAdAnalyze(bvNumber) {
        const video = await initPageObserver();
        if (!video) return;
        state.video = video;
        if (video.duration < SHORT_VIDEO_DURATION ) {
            debuglog(`视频长度不足 - ${video.duration}s`);
            markVideoAsNoAd(bvNumber, {reason:'isShortVideo'});
            return;
        }

        const upInfo = await getUpInfo();
        if (upInfo && upInfo.name) {
            state.upName = upInfo.name;
        }

        if (state.upName && whiteList.includes(state.upName)) {
            log(`✅【白名单】中，跳过`);
            return;
        } else if (upInfo && upInfo.officialOrg) {
            log('✅ 认证机构账号，跳过');
            return;
        } else if (state.noAd) {
            log('🟢 无广告，跳过');
            danmakuManager.stop();
            return;
        } else if (upInfo && upInfo.hasSponsor) {
            log('🤝 含赞助商的联合投稿');
            return true;
        } else if (upInfo && upInfo.fanCount && upInfo.fanCount < 10000) {
            log(`✅ 粉丝数 (${upInfo.fanCount}) < 1万，跳过`);
            return;
        } else if (upInfo && upInfo.memberCount >= 3) {
            log(`🤝【${upInfo.memberCount}人联合投稿】，标记无广`);
            await markVideoAsNoAd(bvNumber, {reason: `${upInfo.memberCount} 人联合投稿)`});
            return;
        } else {
            const videoArea = document.querySelector('.bpx-player-video-area');
            const chargeVideo = videoArea.querySelector('.bpx-player-trial-watch-charging-toast') || document.querySelector('.not-charge-high-level-cover');
            if (chargeVideo) {
                log(`🩷充电专属视频，跳过广告检测`);
                state.noAd = true;
                danmakuManager.stop();
                return;
            }
        }
        return true;
    }

    /** (重构版) 常规模式下的总指挥。
              * 负责：状态重置 -> 获取信息 -> 做出决策 -> 启动监控。*/
    async function handlePageChanges(observer) {
        if (state.isHandling) {
            if(observer) observer.disconnect();
            debuglog('安全措施，返回')
            return;
        }

        state.isHandling = true;

        try {
            log('页面变化，等待元素加载');
            await waitForElement('.v-popover-wrap.header-avatar-wrap').catch(err => { debuglog(`⚠️ ${err.message}`); });//.up-panel-container
            debuglog('🫏 启动页面逻辑');

            const bvNumber = await getBVNumber();
            if (!bvNumber) {
                throw new Error("无法获取BV号，中止处理");
                return;
            }

            // --- 1. 状态重置 ---
            // 只有在【非强制】模式下，才检查URL是否变化
            if (state.currentBV && bvNumber !== state.currentBV) {
                log(`⚠️ BV 变更... ${state.currentBV} -> ${bvNumber}`);
                resetState();
            }
            state.currentBV = bvNumber;
            log(` %c${bvNumber}`,'color: #e67e22; font-weight: bold;');
            const canProceed = await videoNeedAdAnalyze(bvNumber);
            if (canProceed) {
                debuglog('启动广告相关监控...');
                await bindVideoEvents(state.video);
                await processBV(bvNumber);
            }

        } catch (error) {
            console.error('❌ 处理页面变化时发生错误:', error);
        } finally {
            state.isHandling = false;
        }
    }


    /*** (新增) 将所有核心事件绑定到 video 元素上。*/
    async function bindVideoEvents(video) {
        log(`视频状态：${state.video?.paused ? '暂停' : '播放'}`);

        const handlePlay = async () => {
            const currentBV = await getBVNumber();
            if(currentBV !== state.currentBV) {
                debuglog('⚠️ 忽略旧页面的 play 事件');
                return;
            }
            log('▶️ 视频播放中，恢复监控');
            const isTaskConcluded = state.adTime || state.noAd || whiteList.includes(state.upName);
            if (!isTaskConcluded) {
                debuglog('👓重建弹幕观察器...');
                danmakuManager.start();
            } else if (isTaskConcluded) {
                danmakuManager.stop();
            }
        };

        const handlePause = () => {
            log('⏸️ 视频暂停弹幕监控');
            danmakuManager.stop();
        };

        video.removeEventListener('play', await handlePlay);
        video.removeEventListener('pause', handlePause);

        video.addEventListener('play', await handlePlay);
        video.addEventListener('pause', handlePause);

        video.removeEventListener('ended', videoEnded);
        video.addEventListener('ended', videoEnded);

        debuglog('✅ 视频元素绑定事件');
    }


    async function processBV(bvNumber) {
        // 1. 查询云端
        if (!state.bvCloudChecked) {
            state.bvCloudChecked = true;
            const cloudResponse = await fetchAdTimeDataFromCloud(bvNumber);
            if (cloudResponse) {
                const { bestRecord, duplicateCount } = cloudResponse;
                state.cloudDuplicateCount = duplicateCount || 0;

                if (bestRecord) {
                    //云端返回无广告
                    if (bestRecord.NoAD) {
                        log(` 🟢%c noAd`, 'color: #3498db; font-weight: bold;');
                        state.noAd = true;
                        await markVideoAsNoAd(bvNumber, { reason: "cloud_record" });
                        return;
                    } else if (bestRecord.timestamp_range) {
                        //云端返回有效时间戳
                        log(` 🟢 云端: %c${bestRecord.timestamp_range}, %c${bestRecord.source}`, 'color: #3498db; font-weight: bold;', 'color: #e67e22; font-weight: bold;');
                        const dataTimestamp = extractTimestampFromString(bestRecord.timestamp_range);
                        if (dataTimestamp) {
                            state.adTime = dataTimestamp;
                            // 注意：从云端获取的数据，我们通常不希望它再次触发上传
                            monitorTimestamp(bvNumber, dataTimestamp, bestRecord.source, { uploadCloud: false, saveTimestamp: true });
                            return;
                        }
                    }
                }
            }
        }

        // 2. 查本地缓存
        if (!state.adTime){
            const result = await getStoredAdTime(bvNumber);
            if (result) {
                if (result ==="noAd") {
                    log(`❓查询缓存 --> noAd`);
                    danmakuManager.stop();
                    state.noAd = true;
                    return;
                }
                log(`❓查询缓存 --> '${result.adTime}`);
                state.adTime = result.adTime;
                monitorTimestamp(bvNumber, result.adTime, result.source, {uploadCloud: false, saveTimestamp: false});
                return;
            }
            log(`❓查询缓存 --> 无数据`)
        }

        // 3. 启动弹幕监控
        danmakuManager.start();

        // 4. 最后尝试调用AI
        debuglog('⌛检查评论区，调用AI')
        await checkCommentAndHandleAI(bvNumber)
    }


    /** (升级版) 主动滚动页面以帮助加载懒加载元素*/
    function scrollToLoadComments(distance = 50+Math.floor(Math.random()*50)) {
        debuglog(`📜 下滚加载评论区`);
        window.scrollBy({ top: distance, left: 0, behavior: 'smooth' });
    }

    /** 等待通过网络拦截器获取AI字幕。*/
    async function fetchBilibiliSubtitleAPI(timeout = 3000) {
        async function showAiSubtitle() {
            const subtitleCtrlBtn = document.querySelector('.bpx-player-ctrl-btn.bpx-player-ctrl-subtitle');
            if (subtitleCtrlBtn) {
                const subtitleOption = document.querySelector('.bpx-player-ctrl-subtitle-major .bpx-player-ctrl-subtitle-language-item[data-lan="ai-zh"]');
                if (subtitleOption) {
                    subtitleOption.click();
                    await randomSleep(2000);
                    const subtitleClose = document.querySelector('.bpx-player-ctrl-subtitle-close-switch[data-action="close"]');
                    if (subtitleClose) {
                        subtitleClose.click();
                    }
                    return true;
                }
            } else {
                debuglog('❌ 无AI字幕')
            }
            return false;
        }

        const subtitleDataPromise = new Promise((resolve) => {
            subtitlePromiseResolver = (subtitles) => {
                subtitlePromiseResolver = null;
                resolve(subtitles);
            };
        });

        const timeoutPromise = new Promise((resolve) => {
            setTimeout(() => {
                if (subtitlePromiseResolver) {
                    log('⚠️ 等待AI字幕API请求超时');
                    subtitlePromiseResolver = null;
                    resolve([]);
                }
            }, timeout);
        });

        showAiSubtitle().then(triggered => {
            if (!triggered) {
                if (subtitlePromiseResolver) {
                    subtitlePromiseResolver([]);
                }
            }
        });

        const subtitles = await Promise.race([subtitleDataPromise, timeoutPromise]);

        return subtitles;
    }


    function subtitlesFiltering(subtitleObjects, {hasAd = null, reason = null}) {
        const maxSubtitles = 200;
        const subtitlesNum = subtitleObjects.length;
        debuglog(`🔤字幕${subtitlesNum}条，筛选`);

        // 1. 提取关键词匹配的时间点（秒）+ 保留原始字幕对象
        const subtitlesWithSec = subtitleObjects.map(obj => {
            const sec = obj.fromSec !== undefined ? obj.fromSec : timeToSeconds(obj.time);
            return { sec, obj };
        });
        const keywordMatches =subtitlesWithSec.filter(entry => keywordRegex.test(entry.obj.content));

        debuglog(`关键字匹配：${keywordMatches.length}`)
        if (keywordMatches.length === 0) {
            // --- 场景一：字幕中【未】发现关键词 ---
            if (hasAd === true) {
                log('⚠️ 警告：评论区广告，但字幕无关键词。将提交中间部分字幕给AI进行深度分析...');
                const start = Math.floor((subtitlesNum - maxSubtitles) / 2);
                const slicedObjects = subtitleObjects.slice(start, start + maxSubtitles);
                const formattedSlice = slicedObjects.map(obj => {
                    if (obj.fromStr && obj.toStr) {
                        return `${obj.fromStr}-${obj.toStr} ${obj.content}`;
                    }
                    return `${obj.time} ${obj.content}`;
                });

                return {
                    filteredSubtitles: formattedSlice,
                };
            } else if (hasAd === false) {
                // 【评论区无广告，字幕也无关键词】 -> 极大概率无广告
                return {
                    filteredSubtitles: [],
                    subtitlesNoAd:true
                };
            } else {
                log('⚠️ 评论区情况不明！');
            }
        }

        keywordMatches.sort((a, b) => a.sec - b.sec);

        // 2. 找出分段点（相邻时间大于2分钟）
        const segments = [];
        let currentSegment = [keywordMatches[0]];

        for (let i = 1; i < keywordMatches.length; i++) {
            const prev = keywordMatches[i - 1].sec;
            const curr = keywordMatches[i].sec;
            if (curr - prev > 120) {
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
            }).filter(info => info.trim().split(' ')[1]);

            if (segmentInfo.length > 1) {
                //debuglog(`📢广告词Block-${index + 1}: [${segmentInfo.join(', ')}]`);
            }
        });

        // 4. 找到关键词数量最多的一段（你也可以选择最密集的段）
        const bestSegment = segments.reduce((a, b) => (a.length >= b.length ? a : b));

        if (reason === "keyWords") {
            // 对最佳段落进行“多样性”健康度检查 ---
            const totalMatches = bestSegment.length;

            // 提取出所有匹配到的关键词本身
            const matchedWords = bestSegment.map(entry => {
                const match = entry.obj.content.match(keywordRegex);
                return match ? match[0].toLowerCase() : null;
            }).filter(Boolean);

            // 计算【唯一】关键词的数量
            const uniqueWords = [...new Set(matchedWords)];
            const uniqueCount = uniqueWords.length;

            // 计算“多样性占比”
            const diversityRatio = uniqueCount / totalMatches;

            debuglog(`📊 广告词Block分析: 总匹配 ${totalMatches} 次, 唯一词 ${uniqueCount} 个 (${uniqueWords.join(', ')}), 多样性: ${diversityRatio.toFixed(2)}`);

            const maybeAdWords = ['评论','评论区','产品']
            // 4c. 【新增】根据“多样性”进行决策 (降权)
            const isKeywordSpam = (totalMatches >= 8 && uniqueCount <= 3 && diversityRatio <= 0.2) || (uniqueCount <= 2 && maybeAdWords.includes(uniqueWords[0]))

            if (isKeywordSpam) {
                log('🚫 判断为“关键词滥用”，降权处理。此视频大概率无广告。');
                // 降权：返回一个“无广告”的结论
                return { filteredSubtitles: [], localConclusion: 'noAd' };
            }
        }
        // --- 修改结束 ---

        const start = bestSegment[0].sec
        const end = bestSegment[bestSegment.length - 1].sec
        const ext = Math.max(10, 120 - (end - start) / 2);
        const startExt = Math.max(0, start - ext);
        const endExt = end + ext;
        debuglog(`❓扩展广告区域 ${formatTime(startExt)}-${formatTime(endExt)}`);

        // 5. 提取疑似广告部分字幕
        const filteredSubtitles = subtitleObjects
        .filter(obj => {
            const s = obj.fromSec !== undefined ? obj.fromSec : timeToSeconds(obj.time);
            const e = obj.toSec !== undefined ? obj.toSec : s;
            return e >= startExt && s <= endExt;
        })
        .map(obj => {
            if (obj.fromStr && obj.toStr) {
                return `${obj.fromStr}-${obj.toStr} ${obj.content}`;
            }
            return `${obj.time} ${obj.content}`;
        });

        return { filteredSubtitles };
    }


    /** 保存字幕到本地（仅限未下载）*/
    async function trySaveSubtitles(subtitleObjects) {
        if (!DOWNLOAD_SUBTITLE_FILE) return;
        const subtitleArray = subtitleObjects.map(obj => {
            if (obj.fromStr && obj.toStr) {
                return `${obj.fromStr}-${obj.toStr} ${obj.content}`;
            }
            return `${obj.time} ${obj.content}`;
        });
        const bvNumber = await getBVNumber();
        let data = await GM_getValue(bvNumber, {});
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch(e) { data = {}; }
        }

        if (!data.isdownloaded) {
            data.isdownloaded = true;
            await GM_setValue(bvNumber, data);
            // 保存字幕到本地
            const titleEl = document.querySelector('.video-info-title h1.video-title');
            const title = titleEl ? titleEl.textContent.trim().replace(/[\\/:*?"<>|]/g, '') : '无标题';

            const fileName = `UP-(${getUpInfo().name})-${bvNumber}-${title}.json`;
            const blob = new Blob([JSON.stringify(subtitleArray, null, 2)], { type: 'application/json' });
            const urlObject = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = urlObject;
            a.download = fileName;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(urlObject);
            debuglog(`📦保存字幕文件`);
        } else {
            log(`❎跳过保存：视频 ${bvNumber}字幕 已下载`);
        }
    }


    /**
             * (最终优雅版) 纯粹的广告检测器：接收文本和链接字符串数组，返回分析结果。
             */
    function singleFuncForAd({ linkHrefs, commentText, goods = '' }) {
        let hasAd = undefined;
        let reason = null;

        // 1. 检查链接字符串数组
        for (const href of linkHrefs) {
            if (href && biliAdWordsConfig.biliAdLinks.some(blocked => href.includes(blocked))) {
                const cleanHref = href.split('?')[0];
                debuglog('匹配链接: ', cleanHref);
                hasAd = true;
                reason = 'links';
                break;
            }
        }

        // 2. 如果链接未命中，但我们有明确的商品名，也认为是广告
        if (hasAd === undefined && goods) {
            debuglog(`🚚 匹配商品: %c${goods}`);
            hasAd = true;
            reason = 'goods';
        }

        // 2. 如果链接未命中，再检查关键词
        if (hasAd === undefined) {
            const matches = commentText.match(keywordRegex);
            if (matches) {
                const fullMatch = matches[0];
                if (fullMatch === '评论' || fullMatch === '评论区') {
                    hasAd = false;
                } else {
                    debuglog('匹配关键词: ', fullMatch);
                    hasAd = true;
                    reason = 'keyWords';
                }
            } else {
                hasAd = false;
            }
        }

        if (hasAd) {
            log(` 📢%c广告: ${hasAd}, reason: ${reason}`, `color: #e67e22; padding: 2px 5px; font-weight: bold;`);

        }
        //debuglog(`🔝 API置顶评论: %c${commentText.slice(0, 60)}...`);

        return { hasAd: !!hasAd, reason };
    }


    /*** (优化版 - goods优先) 纯函数：分析从API获取的评论JSON中的置顶评论top_replies，返回标准结果。
    * @returns {{hasAd: boolean, commentText: string, goods: string, reason: string|null}|null}  */
    function analyzeCommentJson(top_replies) {
        const topComment = top_replies?.[0];
        if (!topComment) {
            debuglog("❌ 置顶评论字段为空");
            return null;
        }
        if (topComment.reply_control?.is_up_top !== true) {
            debuglog("❌ top_replies非UP手动置顶");
            return null;
        }

        const commentText = topComment.content?.message || '';
        const jumpUrlObject = topComment.content?.jump_url || {};
        const jumpUrlValues = Object.values(jumpUrlObject);

        const productJumpUrls = jumpUrlValues.filter(item => item.extra?.is_word_search !== true);
        const goodsTitles = productJumpUrls.map(item => item.title).filter(Boolean);

        if (goodsTitles.length > 0) {
            const limitedGoodsTitles = goodsTitles.slice(0, 2);
            const goods = limitedGoodsTitles.join('; ');
            debuglog(`🚚 匹配商品: %c${goods}`);

            return {
                hasAd: true,
                reason: 'goods',
                commentText: commentText,
                goods: goods
            };
        }

        const linkHrefs = jumpUrlValues.map(item => item.pc_url).filter(Boolean);
        const adDetectionResult = singleFuncForAd({ linkHrefs, commentText, goods: '' });

        return {
            ...adDetectionResult,
            commentText,
            goods: ''
        };
    }


    /*** (AI分析引擎 - 修正版) 接收字幕和评论信息，执行完整的AI分析流程。
     * @param {string} bvNumber - 视频的BV号。
     * @param {Array<string>} subtitlesArray - 格式为 ["mm:ss content", ...] 的字幕数组。
     * @param {object} commentAnalysis - 从 analyzeCommentJson 返回的评论分析结果。 */
    async function runAiAnalysis(bvNumber, subtitlesArray, commentAnalysis, options = {}) {
        if (state.isAIAnalysisInProgress) {
            log(`[AI引擎] 警告：AI分析流程已被锁定，防止重入 ${bvNumber}。`);
            return;
        }

        log(`🤖 [AI引擎] 分析 ${bvNumber}...`);
        state.isAIAnalysisInProgress = true;

        try {
            // 1. 准备AI参考文本
            let aiReferenceText;
            if (commentAnalysis && commentAnalysis.goods) {
                aiReferenceText = `置顶评论推广商品：${commentAnalysis.goods}`;
            } else if (commentAnalysis.commentText) {
                aiReferenceText = commentAnalysis.commentText;
            } else if (commentAnalysis.reason && commentAnalysis.reason.includes('no_top_comment')) {
                aiReferenceText = "无UP主置顶评论";
            } else {
                aiReferenceText = "评论区未提供有效内容";
            }
            state.commentText = aiReferenceText;

            // 2. 本地预处理
            const subtitlesObjects = subtitlesArray.map(s => {
                const idx = s.indexOf(' ');
                const head = idx > -1 ? s.slice(0, idx) : s;
                const content = idx > -1 ? s.slice(idx + 1) : '';
                if (head.includes('-')) {
                    const [fromStr, toStr] = head.split('-');
                    const fromSec = timeToSeconds(fromStr);
                    const toSec = timeToSeconds(toStr);
                    return { fromStr, toStr, fromSec, toSec, content };
                } else {
                    const fromStr = head;
                    const fromSec = timeToSeconds(fromStr);
                    return { fromStr, toStr: fromStr, fromSec, toSec: fromSec, content };
                }
            });
            const { subtitlesNoAd, filteredSubtitles } = subtitlesFiltering(subtitlesObjects, commentAnalysis);
            trySaveSubtitles(subtitlesObjects);

            // 3. 根据预处理结果决策
            if (subtitlesNoAd && !commentAnalysis.hasAd) {
                log('🚫 本地结论：无广告');
                await markVideoAsNoAd(bvNumber, {upload: true, reason: 'Local Analysis'});
                return;
            }

            if (!filteredSubtitles || filteredSubtitles.length < 20) {
                log('  - ⚠️ 本地分析：未能提取有效的疑似广告字幕，AI分析中止。');
                return;
            }

            // 4. 发送给AI并处理结果
            log(`🔢 提交AI ${filteredSubtitles.length} 条字幕...`);
            const aiResultJson = await sendSubtitlesToAI(bvNumber, filteredSubtitles);
            await processAiResult(bvNumber, aiResultJson, options);

        } catch (err) {
            console.error(`[AI引擎] 在处理 ${bvNumber} 时发生严重错误:`, err);
        } finally {
            debuglog('🔑 [AI引擎] 解除锁定');
            state.isAIAnalysisInProgress = false;
        }
    }


    /** (新增的通用模块) 获取单个视频的置顶评论分析结果。 */
    async function getCommentAnalysis(bvNumber, { allowDomFallback = false, useWbi = false }) {
        let result = { hasAd: false, goods: '', commentText: '', reason: 'unknown_failure' };

        debuglog('⚙️ [评论分析器] 开始...');
        const aid = await getOidFromApi(bvNumber);
        if (!aid) {
            log('ℹ️ [评论分析器] 无法获取视频aid，中止。');
            result.reason = 'no_aid';
            return result;
        }

        if (useWbi) {
            log('  -> 策略: 强制 WBI API');
            const commentDataWBI = await fetchBilibiliComments_WBI({ aid });
            if (commentDataWBI && commentDataWBI.data && commentDataWBI.data.top_replies) {
                const apiResult = analyzeCommentJson(commentDataWBI.data.top_replies);
                if (apiResult) {
                    log('✅ [评论分析器] WBI API 分析成功。');
                    return apiResult;
                }
            }
            result.reason = 'wbi_api_no_top_comment';

        } else {
            // --- 策略B：v1 API 优先，带多种回退 (为UI模式设计) ---
            log('  -> 策略: v1 API 优先 (带回退)');
            const commentData = await fetchBilibiliComments({ aid });
            if (commentData) {
                const apiResult = analyzeCommentJson(commentData.top_replies);
                if (apiResult) {
                    log('✅ [评论分析器] 有置顶');
                    return apiResult;
                } else {
                    result.reason = 'api_no_top_comment';
                    log('🏁 [评论分析器] 无置顶');
                    return result;
                }
            } else {
                // --- API 请求失败 ---
                // 只有在API本身调用失败(commentData为null)时，才进入回退逻辑。
                if (allowDomFallback) {
                    log('ℹ️ API v1 调用失败，回退至DOM轮询模式。');
                    return await getCommentTopAds_VideoPageUI(); // 直接返回DOM的结果
                } else {
                    log('ℹ️ API v1 调用失败，且不允许DOM回退。');
                    result.reason = 'api_v1_failed';
                    const commentDataWBI_fallback = await fetchBilibiliComments_WBI({ aid });
                    if (commentDataWBI_fallback && commentDataWBI_fallback.data && commentDataWBI_fallback.data.top_replies) {
                        const apiResultWBI = analyzeCommentJson(commentDataWBI_fallback.data.top_replies);
                        if (apiResultWBI) {
                            log('✅ [评论分析器] WBI API (回退) 分析成功。');
                            return apiResultWBI;
                        }
                    }
                    return result;
                }
            }

            if (commentData && commentData.top_replies) {
                const apiResult = analyzeCommentJson(commentData.top_replies);
                if (apiResult) {
                    log('✅ [评论分析器] API v1 分析成功。');
                    return apiResult;
                } else {
                    result.reason= 'api_no_top_comment';
                }
            } else {
                if (allowDomFallback) {
                    log('ℹ️ API调用失败或无数据，回退至DOM轮询模式。');
                    result = await getCommentTopAds_VideoPageUI();
                } else {
                    log('ℹ️ API v1 调用失败，且不允许DOM回退。');
                    result.reason = 'api_v1_failed';
                }
            }

            if (result.reason === 'api_v1_failed') {
                const commentDataWBI_fallback = await fetchBilibiliComments_WBI({ aid });
                if (commentDataWBI_fallback && commentDataWBI_fallback.data && commentDataWBI_fallback.data.top_replies) {
                    const apiResultWBI = analyzeCommentJson(commentDataWBI_fallback.data.top_replies);
                    if (apiResultWBI) {
                        log('✅ [评论分析器] WBI API (回退) 分析成功。');
                        return apiResultWBI;
                    }
                }
            }
        }

        log(`[评论] 结论: hasAd=${result.hasAd}, reason=${result.reason || 'none'}`);
        return result;
    }

    /** 检查评论区，并根据需要启动基于API拦截的AI字幕分析。 */
    async function checkCommentAndHandleAI(bvNumber) {
        // 1. 调用通用模块获取评论分析结果，允许DOM回退
        const result = await getCommentAnalysis(bvNumber, { allowDomFallback: true });

        // 2. 决策：是否需要启动AI (仅在UI模式下)
        if (!state.isAIAnalysisInProgress && (FORCE_AI_ACTIVE || result.hasAd)) {
            try {
                log('(UI模式) 等待拦截字幕...');
                const subtitlesArray = await fetchBilibiliSubtitleAPI();
                if (subtitlesArray && subtitlesArray.length > 0) {
                    await runAiAnalysis(bvNumber, subtitlesArray, result);
                } else {
                    log('(UI模式) 无字幕，AI流程中止');
                }
            } finally {
                state.isAIAnalysisInProgress = false;
            }
        }
    }


    // 适配新版UI，提取的评论区检测函数
    function commentAdDetectorByUI() {
        const result = {hasAd: undefined, commentText: '', reason: null}
        const commentsContainer = document.querySelector('#commentapp > bili-comments') || document.querySelector('.bili-dyn-comment > bili-comments');
        if (commentsContainer?.shadowRoot) {
            const thread = commentsContainer.shadowRoot.querySelector('bili-comment-thread-renderer');
            if (thread?.shadowRoot) {
                const commentRenderer = thread.shadowRoot.querySelector('#comment');
                if (commentRenderer?.shadowRoot) {
                    const contentContainer = commentRenderer.shadowRoot.querySelector('#content');
                    if (contentContainer) {
                        const topIndicator = contentContainer.querySelector('#top');
                        if (!topIndicator) {
                            debuglog('ℹ️ 评论区首条为热评');
                            result.hasAd = false;
                            return result;
                        }

                        const richText = contentContainer.querySelector('bili-rich-text');
                        if (richText?.shadowRoot) {
                            const contentsElement = richText.shadowRoot.querySelector('#contents');
                            if (contentsElement) {
                                result.commentText = contentsElement.textContent.trim();
                                const commentText = result.commentText;
                                debuglog(`🔝置顶评论: %c${commentText.slice(0, 50)} ...`);
                                const links = contentsElement.querySelectorAll('a');
                                const linkHrefs = Array.from(links).map(link => link.getAttribute('href'));
                                const adDetectionResult = singleFuncForAd({ linkHrefs, commentText });
                                Object.assign(result, adDetectionResult);
                            }
                        }
                    }
                }
            }
        }
        return result;
    }

    /**  提取评论区文本 */
    async function getCommentTopAds_VideoPageUI() {
        debuglog('等待评论区加载...');
        let result = {};
        for (let i = 0; i < 5; i++) {
            result = commentAdDetectorByUI();
            if (result.hasAd !== undefined) break;
            debuglog(`🛻 评论区重试 (${i + 1}/5)`);
            if (window.scrollY < window.innerWidth/10) {
                scrollToLoadComments(200);
            }
            await randomSleep(1500);
        }

        const backToTop = async () => {
            while (window.scrollY > 50) {
                debuglog('🔝评论区加载，回顶部');
                window.scrollTo({ top: 0, behavior: 'smooth' });
                await randomSleep(500);
            }
        }
        await backToTop();
        return result;
    }

    async function processAiResult(bvNumber, aiResultJson, options = {}) {
        if (aiResultJson ) {
            // 只要AI有结论，就停止弹幕和评论区检查
            danmakuManager.stop();
            if (aiResultJson.noAd === true) {
                //无广告
                log(` ✅ AI返回: %c无广告`, 'color: #3498db; font-weight: bold;');
                playBeepSound(700);
                await markVideoAsNoAd(bvNumber, {upload: true, reason: aiResultJson.source || 'kimi'});
            } else {
                //有时间戳，本地保存 + 共享上传
                log(` 🎯 AI返回: %c${aiResultJson.start}-${aiResultJson.end}`, 'color: #3498db; font-weight: bold;');
                playBeepSound(1100);
                const finalOptions = { ...options, saveTimestamp: true, uploadCloud: true };
                monitorTimestamp(bvNumber, aiResultJson, aiResultJson.source, finalOptions);
            }
        }
    }

    async function monitorTimestamp(bvNumber, dataTimestamp, source, options = {}) {
        //1. 合法性检查
        if (!dataTimestamp || typeof dataTimestamp !== 'object' || !dataTimestamp.start || !dataTimestamp.end) {
            console.warn("❌无效时间戳，跳过", dataTimestamp);
            return;
        }

        //2. 更新state状态，启动视频进度监测
        if (isTrueVideoPage()) {
            state.adTime = dataTimestamp;
            state.video.addEventListener('timeupdate', handleTimeUpdate);
        }

        //3. 本地保存
        if (options.saveTimestamp) {
            storeAdTime(bvNumber, dataTimestamp, source);
        }

        //4. 共享至云端
        if (options.uploadCloud) {
            const duplicateCount = state.cloudDuplicateCount || 0;
            if (duplicateCount >= 2) {
                log(`❎云端已有 ${duplicateCount} 条相同时间戳，忽略共享`);
                return;
            }
            if (!state.uploaded) {
                state.uploaded = true;
                const timestamp_range = `${dataTimestamp.start}-${dataTimestamp.end}`;
                const source_update = (source === "manual" ? 'manual_cloud': source);
                debuglog('⬆️共享', timestamp_range, source_update);
                await uploadAdTimeDataToCloud(bvNumber, timestamp_range, source_update);
            }
        }

        danmakuManager.stop();
    }


    //公共AI服务
    async function publicServiceCore({ platform, body }) {
        const headers = {
            'Content-Type': 'application/json'
        };
        if (platform === 'supabase') {
            headers.Authorization = `Bearer ${supabaseAnonKey.join('.')}`;
        }

        try {
            const response = await fetch( publicAiPlatform[platform], {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(body)
            });

            if (!response.ok) {
                const error = await response.text();
                console.warn(`❌${platform} 服务响应失败：`, response.status, error);
                return null;
            }
            const result = await response.json();
            log(`🤖${platform} AI 返回结果：`, result);
            return result;
        } catch (err) {
            console.error(`❌请求 ${platform} AI 服务异常：`, err);
            return null;
        }
    }


    /** 公共AI服务的统一调用入口。*/
    async function callPublicService({ platform = 'supabase', bv, subtitles }) {
        const user_id = getOrCreateUserId();
        const upInfo = await getUpInfo();
        const up_id = upInfo?.name || 'unknown';
        const commentText = (state.commentText || '').slice(0, 100);
        const body = { bv, subtitles, user_id, up_id, commentText };
        const serverResponse = await publicServiceCore({ platform, body });
        if (serverResponse && serverResponse.success && serverResponse.aiResult) {
            return serverResponse.aiResult;
        }
        return null;
    }


    // 发送字幕到 AI 分析广告时间段
    async function sendSubtitlesToAI(bvNumber, subtitles) {
        // 1. 读取配置
        const configLibrary = await GM_getValue('localAIConfig', { lastSelected: 'kimi' });
        const selectedAI = configLibrary.lastSelected || 'kimi';
        const currentConfig = configLibrary[selectedAI] || {};

        const apiUrl = currentConfig.apiUrl;
        const aiModel = currentConfig.model;
        const apiKey = currentConfig.apiKey || await GM_getValue(`apiKey_${selectedAI}`, null);

        // 2. 参数校验
        if (!apiKey) {
            log('❌未配置AI，调用%c公共AI服务')
            //返回json || null
            return await callPublicService({ platform: cloudPlatformService, bv: bvNumber, subtitles});
        }

        // 3. 构造请求
        log(`模型：${selectedAI} - ${currentConfig.model}`)
        const commentText = state.commentText;
        const system_prompt = `
你是一个精准的广告分析引擎。
你的唯一任务是分析用户提供的视频字幕和评论区文本，判断其中是否包含商业广告，并返回一个结构化的JSON对象。

输入说明：
- 字幕行通常为 "mm:ss.s-mm:ss.s 内容" 的格式，其中前者是该条字幕的开始时间(from)，后者是结束时间(to)，均为 0.1s 精度；
- 如遇仅有单个时间戳的行（例如 "mm:ss 内容"），将其视为仅有起始时间的旧版本字幕。

输出要求（必须严格返回一个 JSON 对象）：
- 必须包含字段：
  - "start": 广告起始时间戳（"mm:ss.s" 或 "hh:mm:ss.s"），精度至少 0.1s；
  - "end": 广告结束时间戳（"mm:ss.s" 或 "hh:mm:ss.s"），精度至少 0.1s；
  - "noAd": 布尔值；如果确定无广告，则为 true；
  - "product": 字符串；广告中推广的商品名称（无法判断可为 null）。
- 若未发现广告，返回 {"start": null, "end": null, "product": null, "noAd": true}。

判定规则：
1) 返回值必须是可被 JSON.parse() 解析的合法 JSON，且不要包含任何多余文字；
2) 时间精度至少 0.1s，且使用 "mm:ss.s" 或 "hh:mm:ss.s" 格式；
3) 广告区段边界由字幕区段决定：
   - "start" = 第一条广告相关字幕的开始时间(from)；
   - "end"   = 最后一条广告相关字幕的结束时间(to)；
4) 将引入广告的话术也视为广告开始（如：“说到...就不得不提...” 等），并覆盖至广告收尾；
5) 返回的区段要尽可能覆盖完整广告，不要遗漏；商业广告通常不少于 30 秒；
6) 不涉及军用装备及法律禁止公开买卖的物品。
`
        const titleEl = document.querySelector('.video-info-title h1.video-title');
        const title = titleEl ? titleEl.textContent.trim() : '';
        const user_prompt = `
以下是视频标题和评论文本，供你参考：\n
标题: ${title}\n
评论: ${commentText}\n\n
以下是截取的部分字幕：\n
${subtitles.join('\n')}
`;
        const requestData = {
            messages: [
                {role: 'system', content: system_prompt,},
                {role: 'user', content: user_prompt,}
            ],
            model: aiModel,
            temperature: 0.2,
            response_format: { type: "json_object" },
            enable_thinking: false,
            max_tokens: 200,
        };

        const isGemini = selectedAI === 'gemini';
        let fetchUrl = apiUrl;
        let fetchOptions = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        };

        // --- 核心转换逻辑 ---
        if (isGemini) {
            // Gemini 的 URL 格式: 基础路径 + 模型名 + :generateContent?key=API_KEY
            fetchUrl = `${apiUrl}${aiModel}:generateContent?key=${apiKey}`;

            fetchOptions.body = JSON.stringify({
                contents: [{
                    parts: [{ text: user_prompt }]
                }],
                systemInstruction: {
                    parts: [{ text: system_prompt }]
                },
                generationConfig: {
                    temperature: 0.2,
                    maxOutputTokens: 200,
                    responseMimeType: "application/json" // 强制返回 JSON
                }
            });
        } else {
            fetchUrl = apiUrl;
            fetchOptions.headers.Authorization = `Bearer ${apiKey}`;
            fetchOptions.headers['Content-Type'] = 'application/json';
            fetchOptions.body = JSON.stringify({
                messages: [
                    { role: 'system', content: system_prompt },
                    { role: 'user', content: user_prompt }
                ],
                model: aiModel,
                temperature: 0.2,
                response_format: { type: "json_object" },
                max_tokens: 200
            });
        }


        try {
            const response = await fetch(fetchUrl, fetchOptions);
            if (response.status === 401) {
                console.warn(`❎错误 401，用户的API Key 无效，调用公共AI服务`);
                //返回 json || null
                return await callPublicService({ platform: cloudPlatformService, bv: bvNumber, subtitles});
            }

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                const errorMessage = errorData?.error?.message || '未知API错误';

                // 【关键】识别“内容过滤”错误，并上报
                if (errorMessage.includes('inappropriate content')) {
                    debuglog(`🚫 AI模型-${selectedAI}  因“内容不适宜”拒绝了请求 [${bvNumber}]`);
                    return null;
                }
                throw new Error(`API 错误: ${response.status} - ${errorMessage}`);
            }

            const rawData = await response.json();
            //debuglog('🤖AI返回原始数据：', rawData);
            let aiRespText = "";

            if (isGemini) {
                // Gemini 的路径: data.candidates[0].content.parts[0].text
                aiRespText = rawData.candidates?.[0]?.content?.parts?.[0]?.text;
            } else {
                // OpenAI 的路径: data.choices[0].message.content
                aiRespText = rawData.choices?.[0]?.message?.content;
            }

            if (!aiRespText) throw new Error('AI 返回数据为空');

            // --- 6. 核心修改：直接解析JSON
            const aiModel = rawData.model || aiModel;
            let aiResultJson;
            try {
                const jsonMatch = aiRespText.match(/```json\n([\s\S]*?)\n```|({[\s\S]*})/);
                if (!jsonMatch) throw new Error("AI回复中未找到有效的JSON代码块");
                aiResultJson= JSON.parse(jsonMatch[1] || jsonMatch[2]);
                log(`🤖AI返回数据`, aiResultJson );
            } catch (e) {
                console.error("❌ JSON解析失败!", "原始回复:", aiRespText, "错误:", e);
                return { status: 500, json: { error: 'AI返回的不是有效的JSON', raw: aiRespText } };
            }

            // --- 7. 根据解析出的JSON，返回标准化的结果 ---
            if (aiResultJson.noAd === true) {
                aiResultJson.source = aiModel;
                return aiResultJson;
            } else if (aiResultJson.start && aiResultJson.end) {
                // 归一化到 0.1s 精度（保持字符串格式）
                try {
                    const s = timeToSeconds(aiResultJson.start);
                    const e = timeToSeconds(aiResultJson.end);
                    return { start: formatTimeTenths(s), end: formatTimeTenths(e), source: aiModel };
                } catch {
                    return { start: aiResultJson.start, end: aiResultJson.end, source: aiModel };
                }
            } else {
                throw new Error('AI返回的JSON内容无效');
            }
        } catch (error) {
            console.error(`❌[${bvNumber}] 本地请求AI失败`, error.message);
        }
    }

    function extractTimestampFromString(timestamp_range) {
        if (!timestamp_range) return null;
        const times = timestamp_range.match(/\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?/g);
        if (!times || times.length < 2) return null;
        log(timestamp_range, times[0], times[1]);
        return {
            start: times[0],
            end: times[1]
        };
    }

    function timeToSeconds(timestamp) {
        if (typeof timestamp !== 'string' || timestamp.trim() === '') {
            return
        }

        const parts = timestamp.split(':').map(part => {
            const num = Number(part);
            if (isNaN(num)) {
                throw new Error(`❌时间戳部分无效: ${part}`);
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
            throw new Error(`❌无效的时间戳格式: ${timestamp}`);
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

    function formatTimeTenths(seconds) {
        if (typeof seconds !== 'number' || isNaN(seconds)) return '';

        const tenths = Math.round(seconds * 10);

        const hrs = Math.floor(tenths / 36000);
        const mins = Math.floor((tenths % 36000) / 600);
        const secs = ((tenths % 600) / 10).toFixed(1);

        const mm = mins.toString().padStart(2, '0');
        const ss = secs.padStart(4, '0');

        if (hrs > 0) {
            return `${hrs}:${mm}:${ss}`;
        }
        return `${mm}:${ss}`;
    }

    const isUpOfficialOrgApi = (() => {
        const cache = new Map();

        return async function(upId) {
            if (!upId) return false;
            if (cache.has(upId)) return cache.get(upId);
            const cardData = await fetchUserCardData({ mid: upId });

            if (cardData && cardData.card) {
                const officialInfo = cardData.card.Official;
                // "role": 3~6 (机构) and "type": 1 (蓝V)
                const isOfficialOrg = officialInfo && (officialInfo.role >= 3 && officialInfo.role <= 6) && officialInfo.type === 1;
                log(`UP主 [%c${cardData.card.name}%c], 认证: ${isOfficialOrg ? '机构' : '非机构'}`, 'color: #e77222; font-weight: bold;', 'color: initial;');
                cache.set(upId, isOfficialOrg);
                return isOfficialOrg;
            }

            console.error(`[isUpOfficialOrgApi] 无法获取UP主 ${upId} 的卡片信息。`);
            cache.set(upId, false);
            return false;
        };
    })();


    /** 通过 B 站官方 API 获取用户卡片（主页）的详细信息。
      内置会话级缓存，避免对同一用户的重复请求。*/
    const fetchUserCardData = (() => {
        const cardApiCache = new Map();

        return async function({ mid }) {
            if (!mid) {
                console.error("[UserCardAPI] 必须提供 mid。");
                return null;
            }
            const cacheKey = `mid_${mid}`;
            if (cardApiCache.has(cacheKey)) {
                return cardApiCache.get(cacheKey);
            }

            const apiUrl = `https://api.bilibili.com/x/web-interface/card?mid=${mid}`;
            try {
                const response = await fetch(apiUrl, { credentials: 'include' });
                if (!response.ok) throw new Error(`请求失败: ${response.status}`);

                const result = await response.json();
                if (result.code !== 0) throw new Error(`API返回错误: ${result.message}`);

                const cardData = result.data;
                if (cardData) {
                    cardApiCache.set(cacheKey, cardData);
                    return cardData;
                }
                return null;
            } catch (error) {
                console.error(`[UserCardAPI] 请求 ${apiUrl} 时发生错误:`, error);
                return null;
            }
        };
    })();


    /** * 获取当前页面的UP主信息。
    内置会话级缓存，确保在单个页面生命周期内只执行一次API请求。*/
    const getUpInfo = (() => {
        const upInfoCache = new Map();

        async function _getUpInfoInternal() {
            const isSpacePage = window.location.href.match(/space.bilibili.com\/(\d+)/);
            const isVideoPage = isTrueVideoPage();

            if (isVideoPage) {
                const bv = await getBVNumber();
                if (!bv) return null;
                const viewData = await fetchVideoViewData({ bvid: bv });
                if (!viewData) return null;

                if (viewData.staff && viewData.staff.length > 0) {
                    log('检测到联合投稿 ');
                    const staff = viewData.staff;
                    const primaryUp = staff.find(s => s.title === 'UP主') || staff[0];
                    const fanCount = primaryUp.follower;
                    const hasSponsor = staff.some(s => s.title === '赞助商');
                    if (hasSponsor) log('🎯 API确认：联合投稿中包含【赞助商】！');
                    const isOfficialOrg = staff.some(s => s.official && s.official.role >= 3 && s.official.role <= 6 && s.official.type === 1);
                    state.officialOrg = isOfficialOrg;
                    return { name: primaryUp.name, id: primaryUp.mid.toString(), memberCount: staff.length, officialOrg: isOfficialOrg, hasSponsor, fanCount };
                } else if (viewData.owner) {
                    const owner = viewData.owner;
                    const fanCount = viewData.stat ? viewData.stat.follower : null;
                    const officialOrg = await isUpOfficialOrgApi(owner.mid);
                    state.officialOrg = officialOrg;
                    return { name: owner.name, id: owner.mid.toString(), memberCount: 1, officialOrg, hasSponsor: false, fanCount };
                }
                return null;
            } else if (isSpacePage) {
                const upId = isSpacePage[1];
                const cardData = await fetchUserCardData({ mid: upId });
                if (cardData && cardData.card) {
                    const card = cardData.card;
                    const officialInfo = card.Official;
                    const isOfficialOrg = officialInfo && (officialInfo.role >= 3 && officialInfo.role <= 6) && officialInfo.type === 1;
                    return { name: card.name, id: upId, memberCount: 1, officialOrg: isOfficialOrg, hasSponsor: false, fanCount: cardData.follower };
                }
                const nicknameElement = document.querySelector('.upinfo-detail .nickname');
                if(nicknameElement) return { name: nicknameElement.textContent.trim(), id: upId };
                return null;
            }
            return null;
        }

        return async function() {
            const isVideoPage = isTrueVideoPage();
            const isSpacePage = window.location.href.match(/space.bilibili.com\/(\d+)/);
            let cacheKey = null;

            if (isVideoPage) {
                const bv = await getBVNumber();
                if (bv) cacheKey = `bv_${bv}`;
            } else if (isSpacePage) {
                cacheKey = `mid_${isSpacePage[1]}`;
            }

            if (!cacheKey) return null;
            if (upInfoCache.has(cacheKey)) {
                return upInfoCache.get(cacheKey);
            }
            //debuglog(`未命中缓存，执行API请求: ${cacheKey}`);
            const result = await _getUpInfoInternal();
            if (result) {
                upInfoCache.set(cacheKey, result);
            }
            return result;
        };
    })();


    /*** 从当前URL获取BV号。
      * - 兼容 BV号、festival页 和 AV号。
      * - 【核心】内置了 AV->BV 的内存缓存，避免在同一页面上重复请求API。 */
    const getBVNumber = (() => {
        return async function() {
            const url = new URL(window.location.href);
            const path = url.pathname;

            // --- 方案 A: 尝试从路径中直接提取 BV 号 ---
            const bvMatch = path.match(/\/video\/(BV\w+)/);
            if (bvMatch) {
                return bvMatch[1];
            }

            // --- 方案 B: 尝试从 festival 等特殊页面的查询参数中提取 BV 号 ---
            if (path.startsWith('/festival/')) {
                const bvidFromQuery = url.searchParams.get('bvid');
                if (bvidFromQuery) {
                    return bvidFromQuery;
                }
            }

            // --- 方案 C: 尝试从路径中提取 AV 号，并调用统一接口 ---
            const avMatch = path.match(/\/video\/av(\d+)/);
            if (avMatch) {
                const aid = avMatch[1];
                const data = await fetchVideoViewData({ aid });
                if (data && data.bvid) {
                    log(`✅ AV [${aid}] 转换为 BV [${data.bvid}]`);
                    return data.bvid;
                } else {
                    console.error(`将 AV 号 ${aid} 转换为 BV 号时出错。`);
                    return null;
                }
            }
            return null;
        };
    })();


    /** 将广告时间戳存入 localStorage，并【同步更新】内存缓存。 */
    async function storeAdTime(bvNumber, adTimestamp, source) {
        let data = await GM_getValue(bvNumber, {});
        if (typeof data === 'string') try { data = JSON.parse(data); } catch(e) { data = {}; }
        if (!data.timestamps) data.timestamps = {};
        data.timestamps[adTimestamp.source || source] = { ...adTimestamp };
        delete data.noAd;
        await GM_setValue(bvNumber, data);
        debuglog(`✅ 时间戳已存入数据库`);

        // 2. 更新当前页面的内存缓存
        if (!scriptCache.mainAdDbKeys.includes(bvNumber)) {
            scriptCache.mainAdDbKeys.push(bvNumber);
        }
        const noAdIndex = scriptCache.noAdDbKeys.indexOf(bvNumber);
        if (noAdIndex > -1) scriptCache.noAdDbKeys.splice(noAdIndex, 1);
        debuglog(`🧠 内存缓存已同步`);


        // --- 3. 【核心修复】在这里，强制同步更新GM存储中的跨域“摘要” ---
        debuglog(`🔁 更新跨域缓存`);
        const crossDomainCache = await GM_getValue('biliCrossDomainCache', { mainAdDbKeys: [], noAdDbKeys: [] });

        if (!crossDomainCache.mainAdDbKeys.includes(bvNumber)) {
            crossDomainCache.mainAdDbKeys.push(bvNumber);
        }
        const noAdCacheIndex = crossDomainCache.noAdDbKeys.indexOf(bvNumber);
        if (noAdCacheIndex > -1) {
            crossDomainCache.noAdDbKeys.splice(noAdCacheIndex, 1);
        }

        await GM_setValue('biliCrossDomainCache', crossDomainCache);
    }

    async function getStoredAdTime(bvNumber) {
        if (scriptCache.noAdDbKeys.includes(bvNumber)) {
            return 'noAd';
        }
        if (scriptCache.mainAdDbKeys.includes(bvNumber)) {
            let data = await GM_getValue(bvNumber, null);
            if (!data) return null;
            if (typeof data === 'string') {
                try { data = JSON.parse(data); } catch(e) { return null; }
            }

            if (data.noAd) {
                return 'noAd';
            }

            const tsObj = data.timestamps;
            if (!tsObj || typeof tsObj !== 'object' || Object.keys(tsObj).length === 0) {
                return null;
            }

            if (tsObj.manual && tsObj.manual.start && tsObj.manual.end) {
                return { adTime: tsObj.manual, source: 'manual' };
            }

            let highPriorityResult = null;
            for (const source in tsObj) {
                if (Object.prototype.hasOwnProperty.call(tsObj, source)) {
                    const lk = source.toLowerCase();
                    if (lk !== 'manual' && lk !== 'danmaku') {
                        const ts = tsObj[source];
                        if (ts && ts.start && ts.end) {
                            highPriorityResult = { adTime: ts, source: source };
                            break;
                        }
                    }
                }
            }
            if (highPriorityResult) {
                return highPriorityResult;
            }

            if (tsObj.Danmaku && tsObj.Danmaku.start && tsObj.Danmaku.end) {
                return { adTime: tsObj.Danmaku, source: 'Danmaku' };
            }
            return null;
        }
        return null;
    }


    /** 标记noAd，并同步更新localStorage, 内存缓存, 和GM跨域摘要*/
    async function markVideoAsNoAd(bvNumber, options = {upload: false, reason: 'unknown'}) {
        log(`✅标记视频无广告`);
        let data = await GM_getValue(bvNumber, {});
        if (typeof data === 'string') try { data = JSON.parse(data); } catch(e) { data = {}; }
        data.noAd = true;
        delete data.timestamps;
        await GM_setValue(bvNumber, data);

        // 2. 更新内存缓存
        if (!scriptCache.noAdDbKeys.includes(bvNumber)) {
            scriptCache.noAdDbKeys.push(bvNumber);
        }
        const mainDbIndex = scriptCache.mainAdDbKeys.indexOf(bvNumber);
        if (mainDbIndex > -1) scriptCache.mainAdDbKeys.splice(mainDbIndex, 1);

        // 3. 更新GM跨域摘要
        if (options.reason === 'iShortVideo') {
            debuglog('视频时长过短，跳过持久化存储和云端上报。');
        } else {
            const crossDomainCache = await GM_getValue('biliCrossDomainCache', { mainAdDbKeys: [], noAdDbKeys: [] });
            if (!crossDomainCache.noAdDbKeys.includes(bvNumber)) {
                crossDomainCache.noAdDbKeys.push(bvNumber);
            }
            const mainCacheIndex = crossDomainCache.mainAdDbKeys.indexOf(bvNumber);
            if (mainCacheIndex > -1) crossDomainCache.mainAdDbKeys.splice(mainCacheIndex, 1);
            await GM_setValue('biliCrossDomainCache', crossDomainCache);

            if (options.upload && !state.uploaded && options.reason !== 'Local Analysis') {
                state.uploaded = true;
                await uploadAdTimeDataToCloud(bvNumber, null, options.reason, true);
            }
        }
        // --- 5. 更新【当前会话】的状态和行为 ---
        danmakuManager.stop();
        if (state.video) {
            state.video.removeEventListener('timeupdate', handleTimeUpdate);
            debuglog('移除 timeupdate');
        }
        state.noAd = true;
        state.adTime = null;
    }


    // ==========================================================
    // ========= 界面配置，全局可复用的“拖拽管理器”模块 ============
    // ==========================================================
    const draggableManager = (() => {
        let targetElement = null;
        let isDragging = false;
        let offsetX, offsetY;

        // --- 【核心】只在脚本启动时，绑定一次全局事件 ---
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


    // ======================================================
    // ================= AI配置UI模块 (封装版) ===============
    // ======================================================

    /** 创建、初始化并管理AI配置UI的所有逻辑。 */
    function setupAiConfigUI() {
        // --- 1. 定义一个固定的、唯一的ID，并实现懒加载 ---
        const CONFIG_POPUP_ID = 'bili-ad-skipper-ai-config-popup';

        // --- 2. 定义所有数据源和配置 ---
        const aiOptions = [
            {value: 'aliyun', text: '阿里云（平台）', apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
             model: ['qwen-plus', 'qwen-plus-latest', 'deepseek-v3.1','deepseek-v3', 'Moonshot-Kimi-K2-Instruct','glm-4.5','glm-4.5-air']
            },
            { value: 'deepseek', text: '深度求索 DeepSeek', apiUrl: 'https://api.deepseek.com/v1/chat/completions', model: ['deepseek-chat'] },
            {value: 'kimi', text: '月之暗面 Kimi', apiUrl: 'https://api.moonshot.cn/v1/chat/completions', model: ['kimi-k2-0905-preview','kimi-k2-0711-preview', 'kimi-k2.5', 'moonshot-v1-32k', 'moonshot-v1-8k' ] },
            {value: 'siliconflow', text: '硅基流动（平台）', apiUrl: 'https://api.siliconflow.cn/v1/chat/completions', model: ['Qwen3-30B-A3B-Instruct-2507','DeepSeek-R1-Distill-Qwen-32B'] },
            {value: 'baidu', text: '百度千帆（平台）', apiUrl: 'https://qianfan.baidubce.com/v2/chat/completions', model: ['ernie-4.5-turbo-latest', 'qwen3-30b-a3b-instruct-2507','qwen3-14b'] },
            {value: 'glm', text: '智谱清言 GLM', apiUrl: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: ['GLM-4.5-Air','GLM-4.5'] },
            {value: 'ChatGPT', text: 'OpenAI', apiUrl: 'https://api.openai.com/v1/chat/completions', model: ['gpt-5.1', 'gpt-5.1-mini', 'gpt-5.1-nano', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-4o-mini', 'gpt-4o' ]},
            { value: 'custom1', text: '自定义AI-1', apiUrl: '', model: '' },
            { value: 'custom2', text: '自定义AI-2', apiUrl: '', model: '' }
        ];

        const aiFormFields = [
            { id: 'AiSelect', label: 'AI提供商：', type: 'select', options: aiOptions.map(o => ({ value: o.value, text: o.text })) },
            { id: 'ModelSelect', label: '模型选择：', type: 'select', options: [] },
            { id: 'ApiUrl', label: 'API URL：', type: 'input', placeholder: '请输入API URL' },
            { id: 'ApiKey', label: 'API KEY：', type: 'input', placeholder: '请输入API Key' }
        ];

        // --- 3. 创建所有UI构建的辅助函数 ---
        const createFormRow = (fieldConfig) => {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; align-items: center; margin-bottom: 10px; gap: 10px;';
            const label = document.createElement('label');
            label.textContent = fieldConfig.label;
            label.style.cssText = 'flex-shrink: 0; width: 90px; text-align: right;';
            let inputElement;
            if (fieldConfig.type === 'select') {
                inputElement = document.createElement('select');
                (fieldConfig.options || []).forEach(opt => {
                    const option = document.createElement('option');
                    option.value = opt.value;
                    option.textContent = opt.text;
                    inputElement.appendChild(option);
                });
            } else {
                inputElement = document.createElement('input');
                inputElement.type = 'text';
                inputElement.placeholder = fieldConfig.placeholder || '';
            }
            inputElement.id = fieldConfig.id;
            inputElement.style.cssText = `flex-grow: 1; min-width: 0; border: 1px solid #ccc;`;
            row.appendChild(label);
            row.appendChild(inputElement);
            return { row, inputElement };
        };

        const createLink = (text, url, container) => {
            const link = document.createElement('a');
            link.href = url;
            link.textContent = text;
            link.style.cssText = 'color: blue; margin: 0 5px; text-decoration: none;';
            link.target = '_blank';
            container.appendChild(link);
        };

        const createButton = (text, onClick) => {
            const button = document.createElement('button');
            button.textContent = text;
            button.style.cssText = `padding: 3px 3px; border: 1px solid #ccc; background: #f0f0f0; border-radius: 4px; cursor: pointer; font-size: 14px;`;
            if (onClick) button.onclick = onClick;
            return button;
        };

        // --- 4. 创建UI主体，并动态生成表单 ---
        const configContainer = document.createElement('div');
        configContainer.id = CONFIG_POPUP_ID;
        configContainer.style.cssText = ` position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); width: 500px; padding: 20px; background: #fff; border: 1px solid #ccc; border-radius: 10px; z-index: 10000; font-size: 16px; box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2); `;

        const configTitle = document.createElement('h3');
        configTitle.textContent = '管理AI配置';
        configTitle.style.cssText = `text-align: center; margin-bottom: 20px; font-weight: bold; cursor: move; user-select: none;`;
        configContainer.appendChild(configTitle);
        draggableManager.makeDraggable(configContainer, configTitle);

        const aiFormElements = {};
        aiFormFields.forEach(field => {
            const { row, inputElement } = createFormRow(field);
            configContainer.appendChild(row);
            aiFormElements[field.id] = inputElement;
        });
        const modelRow = aiFormElements.ModelSelect.parentElement;
        const modelInput = document.createElement('input');
        modelInput.type = 'text';
        modelInput.id = 'ModelInput';
        modelInput.placeholder = '请输入自定义模型名称';
        modelInput.style.cssText = 'flex-grow: 1; min-width: 0; border: 1px solid #ccc; display: none;';
        modelRow.appendChild(modelInput);

        const linksContainer = document.createElement('div');
        linksContainer.style.cssText = 'margin-top: 20px; text-align: center;';
        const descriptionText = document.createTextNode('免费申请apikey：');
        linksContainer.appendChild(descriptionText);
        createLink('阿里云', 'https://bailian.console.aliyun.com/?tab=model#/api-key', linksContainer);
        createLink('Deepseek', 'https://platform.deepseek.com/', linksContainer);
        createLink('Kimi', 'https://platform.moonshot.cn/console/api-keys/', linksContainer);
        createLink('硅基流动', 'https://cloud.siliconflow.cn/sft-keejoek1ys/account/ak', linksContainer);
        createLink('智谱清言', 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys', linksContainer);
        configContainer.appendChild(linksContainer);

        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = 'margin-top: 20px; display: flex; justify-content: center; gap: 10px;';
        const saveButton = createButton('保存配置');
        const cancelButton = createButton('关闭界面');
        buttonContainer.appendChild(saveButton);
        buttonContainer.appendChild(cancelButton);
        configContainer.appendChild(buttonContainer);

        // --- 5. 定义所有事件处理和逻辑函数 ---
        const { AiSelect, ModelSelect, ApiUrl, ApiKey } = aiFormElements;

        const hideAIConfigUI = () => {
            configContainer.style.display = 'none';
        };

        const updateModelDropdown = async () => {
            const selectedAIValue = AiSelect.value;
            const selectedOptionData = aiOptions.find(option => option.value === selectedAIValue);

            if (selectedAIValue.startsWith('custom')) {
                // 自定义AI：显示 input, 隐藏 select
                ModelSelect.style.display = 'none';
                modelInput.style.display = '';
            } else {
                ModelSelect.style.display = '';
                modelInput.style.display = 'none';
                ModelSelect.innerHTML = '';
                if (selectedOptionData && Array.isArray(selectedOptionData.model) && selectedOptionData.model.length > 0) {
                    ModelSelect.disabled = false;
                    selectedOptionData.model.forEach(modelName => {
                        const option = document.createElement('option');
                        option.value = modelName;
                        option.textContent = modelName;
                        ModelSelect.appendChild(option);
                    });
                } else {
                    ModelSelect.disabled = true;
                    ModelSelect.innerHTML = '<option>N/A (请在自定义中输入)</option>';
                }
            }
        };

        async function saveLocalAIConfig() {
            const currentAI = AiSelect.value;
            const configLibrary = await GM_getValue('localAIConfig', { lastSelected: 'kimi' });
            configLibrary.lastSelected = currentAI;
            const modelValue = currentAI.startsWith('custom') ? modelInput.value : ModelSelect.value;
            configLibrary[currentAI] = {
                model: modelValue,
                apiUrl: ApiUrl.value,
                apiKey: ApiKey.value
            };
            await GM_setValue('localAIConfig', configLibrary);
            await GM_deleteValue(`apiKey_${currentAI}`);
            localStorage.setItem('localAIConfig_Backup', JSON.stringify(configLibrary));
            debuglog(`AI配置已更新 (合并存储): \n ${currentAI} - ${modelValue}`);
            uiWindowManager.closeAll();
        }

        async function loadLocalAIConfig() {
            let configLibrary = await GM_getValue('localAIConfig', null);
            if (!configLibrary) {
                const backupConfigString = localStorage.getItem('localAIConfig_Backup');
                if (backupConfigString) {
                    log('⚠️ 从localStorage备份中恢复AI配置...');
                    try {
                        configLibrary = JSON.parse(backupConfigString);
                        await GM_setValue('localAIConfig', configLibrary);
                    } catch(e) { configLibrary = {}; }
                }
            }

            const lastSelectedAI = configLibrary.lastSelected || 'kimi';
            const currentConfig = configLibrary[lastSelectedAI] || {};
            AiSelect.value = lastSelectedAI;
            await updateModelDropdown();
            if (lastSelectedAI.startsWith('custom')) {
                modelInput.value = currentConfig.model || '';
            } else {
                ModelSelect.value = currentConfig.model || '';
            }
            ApiUrl.value = currentConfig.apiUrl || '';
            ApiKey.value = currentConfig.apiKey || await GM_getValue(`apiKey_${lastSelectedAI}`, '');

            const selectedOption = aiOptions.find(option => option.value === lastSelectedAI);
            if (selectedOption && !lastSelectedAI.startsWith('custom')) {
                ApiUrl.value = selectedOption.apiUrl;
            }
        };

        AiSelect.addEventListener('change', async () => {
            const selectedAIValue = AiSelect.value;
            await updateModelDropdown();
            const configLibrary = await GM_getValue('localAIConfig', {});
            const newConfig = configLibrary[selectedAIValue] || {};
            ModelSelect.value = newConfig.model || (ModelSelect.options[0]?.value || '');
            ApiKey.value = newConfig.apiKey || await GM_getValue(`apiKey_${selectedAIValue}`, localStorage.getItem(`apiKey_${selectedAIValue}_Backup`) || '');
            const selectedOption = aiOptions.find(option => option.value === selectedAIValue);
            if (selectedAIValue.startsWith('custom')) {
                ApiUrl.value = newConfig.apiUrl || '';
            } else if (selectedOption) {
                ApiUrl.value = selectedOption.apiUrl;
            }
        });

        // --- 6. 最终的初始化和事件绑定 ---
        saveButton.onclick = saveLocalAIConfig;
        //cancelButton.onclick = hideAIConfigUI;
        cancelButton.onclick = () => uiWindowManager.closeAll();

        document.body.appendChild(configContainer);
        loadLocalAIConfig();
        configContainer.style.display = 'block';
        log('✅ 初始化AI配置UI界面');
    }


    // ======================================================
    // ===========  配置界面：手动配置广告时间戳  =============
    // ======================================================
    async function manualAdTimestamps() {
        // 1. 首先，尝试从当前URL获取BV号
        const isVideoPage = isTrueVideoPage();
        const bvFromUrl = await getBVNumber();
        const containerId = 'bili-ad-timestamp-editor';
        const container = document.createElement('div');
        container.id = containerId;
        container.style.cssText = `
                        position: fixed;
                        top: 30%;
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

        const title = document.createElement('h3');
        title.textContent = `手动配置广告时间戳`;
        title.style.cssText = 'text-align: center; margin-bottom: 20px; font-weight: bold; cursor: move; user-select: none;';
        container.appendChild(title);

        draggableManager.makeDraggable(container, title);

        const mainContentWrapper = document.createElement('div');
        mainContentWrapper.style.cssText = 'position: relative;';

        const inputArea = document.createElement('div');

        // --- 1. 创建一个统一的、可重用的“行构建器”  ---
        function createInputRow(labelText, inputId, placeholder, initialValue = '', options = {}) {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; align-items: center; margin: 0 75px 12px 40px;';

            const label = document.createElement('label');
            label.textContent = labelText;
            label.style.cssText = 'flex: 0 0 85px; text-align: right; margin-right: 10px; font-weight: bold; color: #555;';

            const input = document.createElement('input');
            input.type = 'text';
            input.id = inputId;
            input.placeholder = placeholder;
            input.value = initialValue;
            input.style.cssText = 'flex: 1 1 auto; height: 30px; border: 1px solid #ccc; border-radius: 4px; padding: 0 5px; box-sizing: border-box;';

            row.appendChild(label);
            row.appendChild(input);

            // 辅助函数：执行跳转
            const jumpToTime = (timeStr, offset = 0) => {
                const video = state.video || document.querySelector('video');
                if (!video || !timeStr) return;
                try {
                    const timeSec = /^\d{4}$/.test(timeStr)
                    ? Number(timeStr.substring(0, 2)) * 60 + Number(timeStr.substring(2))
                    : timeToSeconds(timeStr);
                    video.currentTime = Math.max(0, timeSec + offset);
                    video.play();
                } catch (e) { alert('时间格式不正确'); }
            };

            // 辅助函数：抓取当前时间
            const captureTime = () => {
                const video = state.video || document.querySelector('video');
                if (!video) { alert('未找到视频元素'); return; }
                input.value = formatTimeTenths(video.currentTime);
            };

            // 统一的按钮样式生成器
            const createSmallBtn = (text, bgColor, borderColor, callback) => {
                const btn = document.createElement('button');
                btn.textContent = text;
                btn.onclick = callback;
                btn.style.cssText = `
                                margin-left: 10px;
                                padding: 0 10px;
                                height: 30px;
                                font-size: 12px;
                                border-radius: 4px;
                                cursor: pointer;
                                white-space: nowrap;
                                background-color: ${bgColor};
                                border: 1px solid ${borderColor};
                                color: #333;
                             `;
                return btn;
            };

            // --- 按钮逻辑分支 (同时支持跳转与抓取) ---
            if (options.showJumpButton && initialValue) {
                const jumpBtn = createSmallBtn('跳至此处', '#f0f0f0', '#ccc', () => {
                    jumpToTime(input.value, options.jumpOffset || 0);
                });
                row.appendChild(jumpBtn);
            } else if (isVideoPage && options.enableCapture) {
                const captureBtn = createSmallBtn('当前进度', '#e1f5fe', '#81d4fa', () => {
                    captureTime();
                });
                captureBtn.title = "点击填入视频当前播放时间";
                row.appendChild(captureBtn);
            }

            return { row, input };
        }

        // --- 2. 使用新的行构建器来创建所有输入行 ---
        let bvInput, startTimeInput, endTimeInput;

        const bvInitialValue = isVideoPage ? bvFromUrl : '';
        const bvRowData = createInputRow('视频BV号:', 'bili-manual-bv-input', '非视频页面，请输入BV号', bvInitialValue);
        bvInput = bvRowData.input;

        if (isVideoPage) {
            bvInput.disabled = true;
            bvInput.style.backgroundColor = '#f9f9f9';
            bvInput.style.color = '#666';
        }
        inputArea.appendChild(bvRowData.row);

        const storedData = isVideoPage ? await getStoredAdTime(bvFromUrl) : null;
        const start = storedData?.adTime?.start || '';
        const end = storedData?.adTime?.end || '';

        const startTimeRowData = createInputRow('广告起始:', 'StartTime', '格式 00:00.0 或 01:02:03.4', start, { showJumpButton: start, jumpOffset: -3, enableCapture: true } );
        startTimeInput = startTimeRowData.input;
        const endTimeRowData = createInputRow( '广告结束:', ' EndTime', '格式 00:00.0 或 01:02:03.4', end, { showJumpButton: end, jumpOffset: 0, enableCapture: true } );
        endTimeInput = endTimeRowData.input;

        inputArea.appendChild(startTimeRowData.row);
        inputArea.appendChild(endTimeRowData.row);

        // --- 4. 【UI优化】右侧竖条按钮的定位 ---
        if (isVideoPage) {
            const noAdButton = createButton('');
            const rightPosition = '20px';

            noAdButton.style.cssText = `
                            position: absolute;
                            top: 0;
                            right: ${rightPosition};
                            height: 100%;
                            width: 45px;
                            writing-mode: vertical-lr;
                            text-orientation: mixed;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            border-radius: 0 8px 8px 0;
                            border-radius: 5px;
                            border: none;
                            cursor: pointer;
                            font-size: 14px;
                            letter-spacing: 2px;
                            box-shadow: -2px 0 5px rgba(0,0,0,0.05);
                        `;

            const currentData = JSON.parse(localStorage.getItem(bvFromUrl) || '{}');
            if (currentData.noAd) {
                noAdButton.textContent = '撤销该页无广告';
                noAdButton.style.backgroundColor = '#f39c12';
                noAdButton.style.color = 'white';
                noAdButton.onclick = async () => {
                    document.body.removeChild(container);
                    let currentData = await GM_getValue(bvFromUrl, {});
                    delete currentData.noAd;
                    await GM_setValue(bvFromUrl, currentData);
                    await clearAllCachesForBV(bvFromUrl);
                    log(`已取消 ${bvFromUrl} 的无广告标记`);
                };
            } else {
                noAdButton.textContent = '标记该页无广告';
                noAdButton.style.backgroundColor = '#27ae60';
                noAdButton.style.color = 'white';
                noAdButton.onclick = async () => {
                    //clearUI();
                    uiWindowManager.closeAll();
                    await markVideoAsNoAd(bvFromUrl, {upload: true, reason: 'manual_cloud'});
                    log(`已标记为无广告！`);
                };
            }

            mainContentWrapper.appendChild(noAdButton);
        }

        // --- 5. 组装DOM ---
        mainContentWrapper.appendChild(inputArea);
        container.appendChild(mainContentWrapper);

        // --- 3. 按钮容器和按钮 (逻辑简化) ---
        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = 'display: flex; justify-content: center; align-items: center; margin-top: 20px; gap: 10px;';

        // 创建一个函数来生成带样式的按钮
        function createButton(text, onClick) {
            const button = document.createElement('button');
            button.textContent = text;
            // 定义一个基础的按钮样式
            button.style.cssText = `padding: 3px 3px; border: 1px solid #ccc; background: #f0f0f0; border-radius: 4px; cursor: pointer; font-size: 14px;`;
            if (onClick) button.onclick = onClick;
            return button;
        }


        // “保存”按钮
        const saveTimestampButton = createButton('保存配置', async () => {
            const bvNumber = bvFromUrl || bvInput.value.trim();
            if (!bvNumber || !bvNumber.startsWith('BV')) {
                alert('请输入一个有效的BV号！');
                return;
            }

            let startTime = startTimeInput.value.trim();
            let endTime = endTimeInput.value.trim();
            if (startTime && endTime) {
                // 检查时间格式是否正确（支持 0.1s 精度）
                const timeRegex = /^(\d{1,2}:\d{2}(?:\.\d)?|\d{1,2}:\d{2}:\d{2}(?:\.\d)?)$/;
                if (!timeRegex.test(startTime) ) {
                    if (/^\d{4}$/.test(startTime)) {
                        startTime = startTime.substring(0, 2) + ':' + startTime.substring(2);
                    } else {
                        alert('请输入正确的时间格式（例如：05:30.0 或 01:30:45.3）');
                        return;
                    }
                }
                if (!timeRegex.test(endTime)) {
                    if (/^\d{4}$/.test(endTime)) {
                        endTime = endTime.substring(0, 2) + ':' + endTime.substring(2);
                    } else {
                        alert('请输入正确的时间格式（例如：05:30.0 或 01:30:45.3）');
                        return;
                    }
                }
                // 保存广告时间戳到本地、云端
                const dataTimestamp = { start: startTime, end: endTime };
                state.uploaded = false; //手动设置已上传标记为 false
                monitorTimestamp(bvNumber, dataTimestamp, 'manual', {uploadCloud: true, saveTimestamp: true});
                //document.body.removeChild(container);
                uiWindowManager.closeAll();
            } else {
                alert('请输入完整的广告时间戳！');
            }
        });

        buttonContainer.appendChild(saveTimestampButton);
        container.appendChild(buttonContainer);

        if (isVideoPage) {
            const bvNumber = bvFromUrl;
            if (storedData) {
                // “删除”按钮
                const delBtn = createButton('删除该页记录', async () => {
                    await GM_deleteValue(bvNumber);
                    state.adTime = null;
                    clearAllCachesForBV(bvNumber);
                    log(`已清除 ${bvNumber} 数据库数据`);
                    uiWindowManager.closeAll();
                });
                delBtn.style.color = '#e74c3c';
                buttonContainer.appendChild(delBtn);
            }
        }

        // “关闭”按钮
        const cancelButton = createButton('关闭界面', () => {
            //document.body.removeChild(container);
            uiWindowManager.closeAll();
        });
        buttonContainer.appendChild(cancelButton);

        //插入按钮容器
        document.body.appendChild(container);

        /* 工具函数*/
        // 从【所有】缓存中，彻底移除一个BV号的记录。
        async function clearAllCachesForBV(bvNumber) {
            log(`从所有缓存中彻底清理 [${bvNumber}]...`);

            // 1. 清理内存缓存 (scriptCache)
            const noAdIndex = scriptCache.noAdDbKeys.indexOf(bvNumber);
            if (noAdIndex > -1) scriptCache.noAdDbKeys.splice(noAdIndex, 1);

            const mainDbIndex = scriptCache.mainAdDbKeys.indexOf(bvNumber);
            if (mainDbIndex > -1) scriptCache.mainAdDbKeys.splice(mainDbIndex, 1);
            debuglog(`  -> 🧠 内存缓存已清理。`);

            // 2. 清理GM存储中的跨域缓存摘要
            const crossDomainCache = await GM_getValue('biliCrossDomainCache', { mainAdDbKeys: [], noAdDbKeys: [] });

            const noAdCacheIndex = crossDomainCache.noAdDbKeys.indexOf(bvNumber);
            if (noAdCacheIndex > -1) crossDomainCache.noAdDbKeys.splice(noAdCacheIndex, 1);

            const mainCacheIndex = crossDomainCache.mainAdDbKeys.indexOf(bvNumber);
            if (mainCacheIndex > -1) crossDomainCache.mainAdDbKeys.splice(mainCacheIndex, 1);

            await GM_setValue('biliCrossDomainCache', crossDomainCache);
            debuglog(`  -> 🌍 GM跨域缓存摘要已清理。`);
        }

        function clearUI(){
            state.adTime = null;
            if (startTimeInput) {
                startTimeInput.value = '';
            }
            if (endTimeInput) {
                endTimeInput.value = '';
            }

            if (state.video) {
                state.video.removeEventListener('timeupdate', handleTimeUpdate);
                state.video = null;
            }
            document.body.removeChild(container);
        }
    }


    // ================================================
    // ============= UP白名单管理模块 ==================
    // ================================================

    /** 将UP主添加到白名单，并立即更新当前页面的运行状态以停止所有监控。 */
    async function addUpToWhitelistAndUpdateState(upName) {
        if (!upName || typeof upName !== 'string' || upName.trim() === '') {
            debuglog("无效的UP主昵称，无法添加到白名单。");
            return;
        }

        if (whiteList.includes(upName)) {
            debuglog(` UP主 [${upName}] 已在白名单中，无需重复添加。`);
            return;
        }

        log(`➕ 将UP主 [${upName}] 添加到白名单...`);
        // 1. 更新白名单 (内存、GM存储、localStorage备份)
        whiteList.push(upName);
        await GM_setValue('biliUpWhiteList', whiteList);
        localStorage.setItem('biliUpWhiteList_Backup', JSON.stringify(whiteList)); // 写入localStorage备份

        log(`停止当前页面监控`);
        danmakuManager.stop();
        if (state.video) {
            state.video.removeEventListener('timeupdate', handleTimeUpdate);
            debuglog('移除 timeupdate 监听器');
        }
        state.noAd = true;
        state.adTime = null;

        // 4. 更新UI (逻辑不变)
        updateWhiteListDisplay();
        log(`✅ 白名单+ UP主 [${upName}]`);
    }

    /** (新增) 将UP主从白名单移除*/
    async function removeUpFromWhitelist(upName) {
        const index = whiteList.indexOf(upName);
        if (index > -1) {
            log(`➖ 将UP主 [${upName}] 从白名单中移除...`);
            whiteList.splice(index, 1);
            await GM_setValue('biliUpWhiteList', whiteList);
            localStorage.setItem('biliUpWhiteList_Backup', JSON.stringify(whiteList));
            updateWhiteListDisplay();
        }
    }

    /** 更新整个白名单UI的显示，包括列表和动态按钮。*/
    async function updateWhiteListDisplay() {
        // 1. 更新列表显示 (不变)
        const listDisplay = document.getElementById('whiteListDisplay');
        if (listDisplay) {
            listDisplay.textContent = whiteList.join(', ') || '白名单为空';
        }

        const currentUserRow = document.getElementById('bili-current-up-display');
        const upInfo = await getUpInfo();
        if (currentUserRow) {
            if (upInfo && upInfo.name) {
                currentUserRow.innerHTML = `当前页面UP主: <b style="color: #00a1d6;">${upInfo.name}</b>`;
            } else {
                currentUserRow.innerHTML = '';
            }
        }

        // 2. 更新“添加/移除当前页UP”按钮的状态
        const toggleCurrentUpButton = document.getElementById('bili-add-current-up-btn');
        const currentUpBtn = toggleCurrentUpButton;
        if (currentUpBtn) {
            const upInfo = await getUpInfo();
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

    // =================================================
    // ==============  配置界面：白名单管理 ==============
    // =================================================
    async function monitorUpWhiteList() {
        const UpWhiteListContainer = document.createElement('div');
        UpWhiteListContainer.id = 'UpWhiteListContainer';
        UpWhiteListContainer.style.cssText = `
                    position: fixed;
                    top: 30%;
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

        // --- 拖拽代码，改为调用管理器 ---
        draggableManager.makeDraggable(UpWhiteListContainer, Title);

        const toggleUpRow = document.createElement('div');
        toggleUpRow.style.cssText = `display: flex; align-items: center; margin-bottom: 10px; gap: 10px;`;

        const toggleUpLabel = document.createElement('label');
        toggleUpLabel.textContent = '添加/移除UP主:';
        toggleUpLabel.style.cssText = `flex-shrink: 0;`;

        // 为“执行”按钮绑定智能的切换逻辑
        const handleToggle = async () => {
            const upName = toggleUpInput.value.trim();
            if (!upName) return;
            if (whiteList.includes(upName)) {
                await removeUpFromWhitelist(upName);
            } else {
                await addUpToWhitelistAndUpdateState(upName);
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

        // a. 获取当前UP主信息
        const currentUpInfo = await getUpInfo();
        if (currentUpInfo && currentUpInfo.name) {
            const currentUserRow = document.createElement('div');
            currentUserRow.id = 'bili-current-up-display';
            currentUserRow.style.cssText = `text-align: center; font-size: 16px; color: #555; margin: 5px 0; padding: 5px;`;
            UpWhiteListContainer.appendChild(currentUserRow);
        }

        const buttonContainer = document.createElement('div');
        buttonContainer.style.cssText = 'display: flex; justify-content: center; margin: 10px 0; gap: 10px';

        // --- 2. 核心修改：创建【动态】按钮和【统一】的事件处理器 ---
        // 创建“添加/移除当前页UP”按钮，并给它一个固定的ID
        const toggleCurrentUpButton = document.createElement('button');
        toggleCurrentUpButton.id = 'bili-add-current-up-btn';
        toggleCurrentUpButton.style.cssText = `color: white; padding: 4px 5px; margin: 0 5px; border: none; border-radius: 4px;`;

        // 创建一个函数来生成带样式的按钮
        function createButton(text, onClick) {
            const button = document.createElement('button');
            button.textContent = text;
            button.style.cssText = `padding: 3px 3px; border: 1px solid #ccc; background: #f0f0f0; border-radius: 4px; cursor: pointer; font-size: 14px;`;
            if (onClick) button.onclick = onClick;
            return button;
        }

        // 创建“完成”按钮
        const finishButton = createButton('关闭界面', () => {
            //document.body.removeChild(UpWhiteListContainer);
            uiWindowManager.closeAll();
        })

        //插入元素
        buttonContainer.appendChild(toggleCurrentUpButton);
        buttonContainer.appendChild(finishButton);
        UpWhiteListContainer.appendChild(buttonContainer);
        document.body.appendChild(UpWhiteListContainer);

        // --- 3. 首次渲染UI ---
        updateWhiteListDisplay();

        // 【核心】为“动态按钮”绑定一个【统一的】点击事件处理器
        toggleCurrentUpButton.addEventListener('click', async () => {
            const upInfo = await getUpInfo();
            if (upInfo && upInfo.name) {
                if (whiteList.includes(upInfo.name)) {
                    await removeUpFromWhitelist(upInfo.name);
                } else {
                    await addUpToWhitelistAndUpdateState(upInfo.name);
                }
            }
        });
    }

    const uiWindowManager = {
        windows: {},
        register(id, openFunc) {
            this.windows[id] = { open: openFunc };
        },
        closeAll() {
            for (const id in this.windows) {
                const element = document.getElementById(id);
                if (element) {
                    element.remove();
                }
            }
        },
        open(id) {
            this.closeAll();
            if (this.windows[id] && typeof this.windows[id].open === 'function') {
                this.windows[id].open();
            } else {
                console.error(`[WindowManager] 尝试打开一个未注册的窗口: ${id}`);
            }
        }
    };

    function registerMenuUI(menuText, containerId, openFunction, options = {}) {
        uiWindowManager.register(containerId, openFunction);
        GM_registerMenuCommand(menuText, () => uiWindowManager.open(containerId));
    }

    //----------------------------整合弹幕识别脚本-------------------------------
    const timeRegexList = [
        { regex: /\b(\d{1,2})[:：]([0-5]\d)\b/, isFuzzy: false }, // 5:14
        { regex: /(\d{1,2}|[一二三四五六七八九十]{1,3})分(\d{1,2}|[零一二三四五六七八九十]{1,3})/, isFuzzy: false },
        { regex: /(\d{1,2})\.(\d{1,2})[郎朗]/, isFuzzy: false },
        { regex: /(?<!\d)(?:(\d{2})\.(\d{1,2})|(\d{1,2})\.(\d{2}))(?![\d郎君侠降秒分：wk+＋])/i, isFuzzy: true } // 模糊时间戳：纯数字 5.14，排除1.9这种
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

    const TIME_GROUP_THRESHOLD = 10;
    const MIN_JUMP_INTERVAL = 5; //跳转冷静期，防止频繁跳转
    const MIN_COUNT_TO_LOG = 2;

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
                const isAdTs = /[郎朗君菌侠降猜秒谢我]/.test(text) || (isChinese[0] !== isChinese[1])
                if (!isNaN(ts) && ts >= 30) { //限制广告时间戳位置在00:30之后
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

    // (重构版) 弹幕突变处理器，只负责【采集】弹幕数据并存入新仓库。
    async function handleDanmakuMutations(mutationsList) {
        if (state.officialOrg === null) {
            const upInfo = await getUpInfo();
            state.officialOrg = upInfo.officialOrg;
        } else if (state.officialOrg) {
            danmakuManager.stop();
            return;
        }

        if (!state.video) return; // 必须有video对象才能获取当前时间

        for (const mutation of mutationsList) {
            for (const node of mutation.addedNodes) {
                if (node._danmakuHandled) continue;
                node._danmakuHandled = true;

                const text = node.textContent.trim();
                if (text.length === 0 || text === '9麤') continue;

                const result = extractTimestamps(text);
                if (result) {
                    const ts = result.timestamp;
                    const currentTime = state.video.currentTime;

                    // --- 核心修改：在这里实现“写入时聚类” ---
                    let clusterKey = null;
                    for (const existingTsKey in state.danmakuTimestampStore) {
                        const existingTs = Number(existingTsKey);
                        if (Math.abs(ts - existingTs) <= TIME_GROUP_THRESHOLD) {
                            clusterKey = existingTs;
                            break;
                        }
                    }
                    if (clusterKey === null) {
                        clusterKey = ts;
                        state.danmakuTimestampStore[clusterKey] = [];
                    }
                    const occurrence = {
                        savedAt: currentTime,
                        count: result.isAdTs ? 2 : 1
                    };
                    state.danmakuTimestampStore[clusterKey].push(occurrence);
                }
            }
        }
    }


    /** 弹幕心跳处理器。*/
    async function processDanmakuHeartbeat() {
        if ( !state.video || (state.video && state.video.paused) || state.noAd || state.adTime) {
            danmakuManager.stop();
            return;
        }

        const conclusion = analyzeDanmakuStore({ isRealtime: true });
        if (conclusion) {
            await monitorTimestamp(state.currentBV, conclusion, conclusion.source, {uploadCloud:true, saveTimestamp: true});
            danmakuManager.stop();
        }
        return;
    }


    /** 弹幕监控的【全局单例管理器】 */
    const danmakuManager = (() => {
        let internalObserver = null;
        let internalInterval = null;
        let isRunning = false;

        const stopInternal = () => {
            if (internalObserver) {
                internalObserver.disconnect();
                internalObserver = null;
            }
            if (internalInterval) {
                clearInterval(internalInterval);
                internalInterval = null;
                log('🚫 已停止弹幕监控');
            }
            isRunning = false;
        };
        return {
            stop: function() {
                stopInternal();
            },
            start: async function() {
                if (isRunning) {
                    debuglog("弹幕监控运行中...");
                    return;
                }
                const canProceed = await videoNeedAdAnalyze();
                if (!canProceed || state.noAd || state.adTime) {
                    debuglog("无需启动弹幕");
                    return;
                }
                isRunning = true;
                log('🔛 尝试启动弹幕监控...');
                try {
                    const auxiliaryContainer = await waitForElement('.bpx-player-auxiliary', 5000);
                    const danmakuHeader = auxiliaryContainer.querySelector('.bui-collapse-header');
                    const danmakuWrap = auxiliaryContainer.querySelector('.bui-collapse-wrap');

                    if (danmakuHeader && danmakuWrap && danmakuWrap.classList.contains('bui-collapse-wrap-folded')) {
                        debuglog('  -> 展开弹幕...');
                        danmakuHeader.click();
                        setTimeout(() => {
                            if (document.body.contains(danmakuHeader)) {
                                danmakuHeader.click();
                            }}, 3000);
                        await randomSleep(50);
                    }
                } catch (e) {
                    debuglog("  -> 展开弹幕列表失败 :", e.message);
                }

                const checkInterval = setInterval(() => {
                    if (!isRunning) {
                        clearInterval(checkInterval);
                        return;
                    }

                    const container = document.querySelector('div.bpx-player-render-dm-wrap > div.bpx-player-dm-mask-wrap > div.bpx-player-row-dm-wrap');
                    if (container) {
                        clearInterval(checkInterval);

                        log('📸绑定弹幕容器监控');
                        internalObserver = new MutationObserver(handleDanmakuMutations);
                        internalObserver.observe(container, { childList: true, subtree: true });
                        internalInterval = setInterval(() => {
                            if (!isRunning) {
                                stopInternal();
                                return;
                            }
                            log("🩷 Danmaku 心跳 ...");
                            processDanmakuHeartbeat();
                        }, 1500);
                    }
                }, 1000);
            }
        };
    })();


    function videoEnded() {
        debuglog('🔚视频播放已结束');
        danmakuManager.stop();
    }

    /*** (重构版) “纯粹的”页面观察器，只负责异步等待关键元素加载完毕。*/
    async function initPageObserver() {
        log('等待播放器元素加载...');
        try {
            const videoArea = await waitForElement('.bpx-player-video-area');
            const video = await waitForElement('video', 10000, videoArea);
            log('✅ -> 加载成功');
            return video;
        } catch (error) {
            log(`❌ -> 加载失败, ${error.message}`);
            return null;
        }
    }

    function convertToRelativeTime(str) {
        const t = new Date(str);
        const now = new Date();
        if (isNaN(t.getTime())) return str;

        const diff = Math.floor((now - t) / 1000);
        if (diff < 60) return `${diff}秒前`;
        if (diff < 3600) {
            const m = Math.floor(diff / 60);
            const s = diff % 60;
            return s > 0 ? `${m}分${s}秒前` : `${m}分钟前`;
        }

        if (diff < 86400) {
            const h = Math.floor(diff / 3600);
            const m = Math.floor((diff % 3600) / 60);
            return m > 0 ? `${h}小时${m}分前` : `${h}小时前`;
        }

        if (diff < 31536000) {
            const d = Math.floor(diff / 86400);
            const h = Math.floor((diff % 86400) / 3600);
            return h > 0 ? `${d}天${h}小时前` : `${d}天前`;
        }

        const y = Math.floor(diff / 31536000);
        const d = Math.floor((diff % 31536000) / 86400);
        return d > 0 ? `${y}年${d}天前` : `${y}年前`;
    }


    function setupNavigationObserver() {
        const styleId = 'bili-ad-skip-relative-time-style';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                            #viewbox_report .video-info-meta .pubdate-ip-text[data-custom-time]::after {
                                content: attr(data-custom-time);
                                visibility: visible !important;
                                display: inline-block !important;
                                font-size: 13px !important;
                                line-height: 18px !important;
                                color: #e67e22 !important;
                                font-weight: bold;
                                background: rgba(245, 245, 245, 0.85);
                                padding: 0 4px;
                                border-radius: 4px;
                                white-space: nowrap;
                                position: relative;
                                top: 0px;
                            }
                        `;
            document.head.appendChild(style);
        }

        // --- 1. 修改逻辑：增加“内容变更检测” ---
        const modifyVideoInfoMeta = () => {
            const textSpan = document.querySelector("#viewbox_report .video-info-meta .pubdate-ip .pubdate-ip-text");
            if (!textSpan) return;
            const currentText = textSpan.textContent.trim();
            if (!currentText) return;
            const lastProcessedText = textSpan.getAttribute('data-orig-text');
            if (lastProcessedText === currentText) return;
            const newRelativeText = '⏱️' + convertToRelativeTime(currentText);
            textSpan.title = currentText;
            textSpan.setAttribute('data-custom-time', newRelativeText);
            textSpan.setAttribute('data-orig-text', currentText);
        };

        // --- 2. 观察器部分 ---
        let lastExecutionTime = 0;
        const throttleDelay = 200;

        const mainObserverCallback = (mutationsList) => {
            const now = Date.now();
            if (state.isHandling) return;
            if (now - lastExecutionTime < throttleDelay) return;
            lastExecutionTime = now;
            requestAnimationFrame(async () => {
                if (window.location.href.match(/bilibili.com\/video\//)) {
                    modifyVideoInfoMeta();
                }

                const currentBV = await getBVNumber();
                if (currentBV) {
                    if (currentBV !== state.currentBV || (!state.video && !state.isHandling)) {
                        handlePageChanges();
                    }
                }
            });
        };

        const mainObserver = new MutationObserver(mainObserverCallback);
        const createMainObserver = () => {
            // 观察子节点变化 (childList) 和 字符数据变化 (characterData)
            // 虽然 Vue 通常是替换节点内容，但加上 subtree 比较保险
            mainObserver.observe(document.body, { childList: true, subtree: true });
        }

        if (document.body) {
            createMainObserver();
            log('✅ 主导航观察器已启动 (SPA 适配版)');
        } else {
            window.addEventListener('DOMContentLoaded', createMainObserver , { once: true });
        }
    }

    /**
                 * (静默巡查核心) 通过 x/player/wbi/v2 接口获取AI字幕的URL。
                 * @param {string|number} aid - 视频的AV号。
                 * @param {string|number} cid - 视频的CID。
                 * @returns {Promise<string|null>} 成功时返回完整的字幕文件URL，失败时返回null。
                 */
    async function fetchSubtitleUrl({aid, cid}) {
        if (!gState.deviceFingerprint) {
            console.error(`[SilentScan] 无法获取字幕URL，因为设备指纹尚未被借用。`);
            return null;
        }

        try {
            const baseParams = {
                aid: aid,
                cid: cid,
                isGaiaAvoided: false // 固定参数
            };

            // 将借来的指纹参数合并进去
            const finalParams = { ...baseParams, ...gState.deviceFingerprint };

            // 使用已有的 WBI 签名工具
            const signedParams = await wbiSigner.sign(finalParams);

            const apiUrl = new URL('https://api.bilibili.com/x/player/wbi/v2');
            for (const key in signedParams) {
                apiUrl.searchParams.set(key, signedParams[key]);
            }

            const response = await gState.originalFetch(apiUrl.toString(), { credentials: 'include' });
            if (!response.ok) throw new Error(`API response not OK: ${response.status}`);

            const data = await response.json();
            if (data.code !== 0) throw new Error(`API returned error code: ${data.code}`);

            const subtitles = data?.data?.subtitle?.subtitles;
            if (subtitles && subtitles.length > 0) {
                // 查找中文AI字幕
                const aiZhSubtitle = subtitles.find(s => s.lan === 'ai-zh');
                if (aiZhSubtitle && aiZhSubtitle.subtitle_url) {
                    // 补全协议并返回
                    return 'https:' + aiZhSubtitle.subtitle_url;
                }
            }
            return null; // 没有找到AI字幕
        } catch (err) {
            console.error(`[SilentScan] fetchSubtitleUrl 失败 for aid ${aid}:`, err);
            return null;
        }
    }

    /** 弹幕时间戳仓库分析引擎*/
    function analyzeDanmakuStore(options = {}) {
        const isRealtime = options.isRealtime || false;
        const currentTime = state.video ? state.video.currentTime : 0;
        let bestCandidate = null;

        const dmArray = state.danmakuTimestampStore;
        for (const tsKey in dmArray) {
            let occurrences = dmArray[tsKey] || [];
            const ts = Number(tsKey);

            // 实时模式下的筛选 (不变)
            if (isRealtime) {
                occurrences = occurrences.filter(occ => (currentTime - occ.savedAt) < 10);
            }
            if (occurrences.length === 0) continue;

            // 第一次筛选净化 (不变)
            const cleanedOccurrences = occurrences.filter(occ => {
                return occ.savedAt >= 15 &&
                    ((ts > occ.savedAt && ts - occ.savedAt <= 240 && ts - occ.savedAt > 10) ||
                     (ts < occ.savedAt && occ.savedAt - ts < 8));
            });

            // 如果清洗后为空，则跳过
            if (cleanedOccurrences.length === 0) {
                delete dmArray[tsKey];
                continue;
            }
            // 更新 dmArray[tsKey] 为净化后的版本
            dmArray[tsKey] = cleanedOccurrences;

            // --- 基于净化后的数据进行后续所有操作 ---

            // 1. 计算总权重
            const totalCount = cleanedOccurrences.reduce((sum, occ) => sum + occ.count, 0);
            if (totalCount < MIN_COUNT_TO_LOG) continue;

            // 2. 从 cleanedOccurrences 中筛选出有效的前置弹幕
            const validStartCandidates = cleanedOccurrences.filter(occ =>ts > occ.savedAt && ts - occ.savedAt > 10);

            if (validStartCandidates.length === 0) continue;

            // 3. 实现新的起始时间计算逻辑
            let finalStartTime;
            validStartCandidates.sort((a, b) => a.savedAt - b.savedAt);

            if (validStartCandidates.length >= 3) {
                finalStartTime = validStartCandidates[1].savedAt;
            } else {
                finalStartTime = validStartCandidates[0].savedAt;
            }

            // --- 后续检查逻辑 (剔除虚假、实时性检查) ---
            if (finalStartTime >= ts) continue;
            if (isRealtime && (ts <= currentTime)) continue;

            // 4. 更新最佳候选
            if (!bestCandidate || totalCount > bestCandidate.count) {
                bestCandidate = {
                    ts: ts,
                    startTime: finalStartTime,
                    count: totalCount
                };
            }
        }

        if (bestCandidate) {
            const conclusion = {
                start: formatTime(bestCandidate.startTime),
                end: formatTime(bestCandidate.ts),
                source: 'Danmaku'
            };
            const adTimestamp = `${conclusion.start}-${conclusion.end}`
            log(`🎯 弹幕: %c${adTimestamp}(权重: ${bestCandidate.count})`, 'color: #a498db; font-weight: bold;');
            playBeepSound();
            return conclusion;
        }

        return null;
    }

    /**
             * (优化版) 解析动态页评论区置顶内容，兼容新旧两种UI版本。
             * @param {HTMLElement} panel - 动态卡片的评论区面板元素。
             * @returns {Promise<{hasAd: boolean|undefined, commentText: string, reason:null|string}>}
             */
    async function getCommentTopAds_DynPage(panel) {
        let result = {hasAd: undefined, commentText: '', reason: null}
        try {
            debuglog('检查新版动态评论区');
            for (let i = 0; i < 5; i++) {
                result = commentAdDetectorByUI();
                if (result.hasAd !== undefined) break;
                await randomSleep(300);
            }
            if (result.hasAd !== undefined) {
                return result;
            }
            throw new Error("新版评论区内部结构不匹配");
        } catch (error) {
            try {
                const topCommentElement = await waitForElement('.list-item.reply-wrap.is-top .text', 1000, panel);
                if (!topCommentElement) return result;
                result.commentText = topCommentElement.textContent.trim();
                const links = topCommentElement.querySelectorAll('a.comment-jump-url');
                const linkHrefs = Array.from(links).map(link => link.getAttribute('href'));
                const adDetectionResult = singleFuncForAd({ linkHrefs, commentText: result.commentText });
                Object.assign(result, adDetectionResult);

                log(` 📢 动态页评论区分析: %c${result.hasAd ? '发现广告' : '未发现广告'}`, `color: ${result.hasAd ? '#e67e22' : '#2ecc71'}; font-weight: bold;`);
                return result;

            } catch (e) {
                return result;
            }
        }
    }


    /** * (修正版) 专门处理B站动态页面的总入口和导航监控函数。 */
    async function handleMainDynPageNavigation() { return; }

    /** (最终版 - 混合动力监控) 专门处理B站空间页面的总入口和导航监控函数。 */
    async function handleSpacePageNavigation() { return; }

    /** (新增) 从内存缓存中【同步地】检查一个视频的广告状态。*/
    function checkVideoStatusFromCache(bvNumber) {
        if (scriptCache.noAdDbKeys.includes(bvNumber)) {
            return 'noAd';
        }
        if (scriptCache.mainAdDbKeys.includes(bvNumber)) {
            return 'hasAd';
        }
        return null;
    }

    /** 辅助函数：解析B站日期字符串。*/
    function parseUploadDate(dateStr) {
        const now = new Date();
        if (dateStr.includes('前')) return now;
        if (dateStr.includes('昨天')) { const d = new Date(); d.setDate(d.getDate() - 1); return d; }
        if (/^\d{2}-\d{2}$/.test(dateStr)) return new Date(`${now.getFullYear()}-${dateStr}`);
        if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return new Date(dateStr);
        return now;
    }


    /** 辅助函数：等待元素加载。*/
    function waitForElement(selector, timeout = 5000, parent = document ) {
        return new Promise((resolve, reject) => {
            const interval = setInterval(() => {
                const element = parent.querySelector(selector);
                if (element) {
                    clearInterval(interval);
                    resolve(element);
                }
            }, 200);
            setTimeout(() => {
                clearInterval(interval);
                reject(new Error(`等待元素超时: ${selector}`));
            }, timeout);
        });
    }

    /** (优化版) 根据当前页面类型，【轻量级地】加载数据到内存缓存。*/
    async function loadDataForCurrentMode(scriptMode) {
        const isVideoPage = isTrueVideoPage();
        const isUpListPage = window.location.href.includes('/space.bilibili.com/');

        // --- 核心修改：统一从GM存储加载缓存摘要 ---
        if (isVideoPage || isUpListPage) {
            debuglog(' -> 加载跨域缓存摘要...');
            const crossDomainCache = await GM_getValue('biliCrossDomainCache', { mainAdDbKeys: [], noAdDbKeys: [] });
            scriptCache.mainAdDbKeys = crossDomainCache.mainAdDbKeys;
            scriptCache.noAdDbKeys = crossDomainCache.noAdDbKeys;
            debuglog(` ->广告: ${scriptCache.mainAdDbKeys.length}, 无广: ${scriptCache.noAdDbKeys.length}`);
        }

        debuglog(' -> 加载UP白名单...');
        whiteList = await GM_getValue('biliUpWhiteList', []);
        debuglog('✅ 数据加载完成');
    }


    /** (新增) 通过view API查询指定BV号是否包含重定向URL */
    async function fetchRedirectUrlForBv(bvid) {
        if (!bvid) return null;
        const data = await fetchVideoViewData({ bvid });
        return data?.redirect_url || null;
    }

    async function determineMode() {
        const scriptMode = window.location.href.includes('/video/BV') ? 'normal' : 'idle';
        log(`当前脚本模式: ${scriptMode.toUpperCase()}`);
        return scriptMode;
    }

    function isTrueVideoPage() {
        const href = window.location.href;
        const pathname = window.location.pathname;
        // 规则 1 & 2: 标准的 BV/AV 视频页面
        if (pathname.startsWith('/video/BV') || pathname.startsWith('/video/av')) {
            return true;
        }
        // 规则 3: 特殊活动页，但URL中必须带有 bvid 参数
        if (pathname.startsWith('/festival/') && new URL(href).searchParams.has('bvid')) {
            return true;
        }
        return false;
    }

    /** 步骤三：根据模式和页面类型，执行对应的核心业务逻辑。*/
    async function executeMainLogic(scriptMode) {
        const isBiliSpacePage = window.location.href.includes('space.bilibili.com');
        const isUpVideoListPage = window.location.href.match(/space.bilibili.com\/(\d+)\/upload\/video/);
        const isVideoPage = isTrueVideoPage();
        const isDynPage = window.location.href.includes('t.bilibili.com');
        const pathWithoutSlash = window.location.pathname.replace(/^\/+/, '').replace(/\/+$/, '');

        const path = window.location.pathname;
        if (pathWithoutSlash !== '' || /^\d{16,}$/.test(pathWithoutSlash)) {
            debuglog('🌀 非动态首页, todo...');
        }

        log(`模式 [${scriptMode.toUpperCase()}] 执行主逻辑`);

        if (isVideoPage) {
            setupNavigationObserver();
        } else {
            debuglog('...空闲模式，无操作');
        }
    }

    /** 将GM存储中的核心数据，备份到localStorage。*/
    async function backupGmStorageToLocalStorage() {
        log('🛡️ 执行核心数据到 localStorage 的冗余备份...');
        try {
            const biliUpWhiteList = await GM_getValue('biliUpWhiteList', []);
            const crossDomainCache = await GM_getValue('biliCrossDomainCache', { mainAdDbKeys: [], noAdDbKeys: [] });
            const backupData = { biliUpWhiteList, biliCrossDomainCache, backupTimestamp: Date.now() };
            localStorage.setItem('BiliAdSkip_GM_Backup', JSON.stringify(backupData));
            debuglog('  -> ✅ 备份完成');
        } catch(e) {
            console.error("❌ 核心数据备份失败:", e);
        }
    }

    /** 检查GM存储是否为空，如果为空，则尝试从localStorage的备份中恢复。*/
    async function restoreGmStorageFromLocalStorage() {
        const backupString = localStorage.getItem('BiliAdSkip_GM_Backup');
        if (!backupString) return;
        try {
            const backupData = JSON.parse(backupString);
            if (backupData.biliUpWhiteList) {
                await GM_setValue('biliUpWhiteList', backupData.biliUpWhiteList);
            }
            if (backupData.biliCrossDomainCache) {
                await GM_setValue('biliCrossDomainCache', backupData.biliCrossDomainCache);
            }
            log('✅ 成功从 localStorage 恢复轻量版核心数据');
        } catch (e) {
            console.error("❌ 从备份恢复数据失败:", e);
        }
    }

    /** (修复版) 导出所有GM存储数据（包含视频详情）为一个JSON文件，并触发下载。*/
    async function exportAllDataAsJson() {
        log('🛡️ 准备导出数据库全量备份 (结构优化版)...');
        try {
            const allKeys = await GM_listValues();
            const backupData = {
                // 元数据，方便版本管理
                __meta__: {
                    timestamp: Date.now(),
                    exportVersion: 2,
                    userAgent: navigator.userAgent
                },
                videoData: {},
            };

            // 【核心修改】扩大了忽略列表，过滤掉所有系统状态标记
            const ignoreKeys = [
                // 临时运行状态
                'biliScriptModeBeacon',
                'biliUpScanState',
                'bili_wbi_keys',
                'BiliAdSkip_TransitCache',
                // 历史迁移与维护标记
                'bili_ls_migrated_v2',
            ];

            let videoCount = 0;
            let configCount = 0;

            await Promise.all(allKeys.map(async (key) => {
                if (ignoreKeys.includes(key)) return;

                const value = await GM_getValue(key, null);
                if (value === null) return;

                if (key.startsWith('BV')) {
                    backupData.videoData[key] = value;
                    videoCount++;
                } else {
                    backupData[key] = value;
                    configCount++;
                }
            }));

            if (videoCount === 0 && configCount === 0) {
                debuglog("没有找到任何可备份的数据！");
                return;
            }

            // 导出文件
            const jsonString = JSON.stringify(backupData, null, 2);
            const blob = new Blob([jsonString], { type: 'application/json' });
            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = url;
            const timestamp = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
            a.download = `BiliAdSkip_Backup_v2_${timestamp}.json`;

            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

            log(`✅ 备份成功！包含 ${videoCount} 个视频数据，${configCount} 项配置。`);

        } catch (e) {
            console.error("❌ 导出数据时发生错误:", e);
        }
    }

    // =============================================================
    // =================== B站加密弹幕本地解析模块 ===================
    // =============================================================

    /**
             * (核心) 提供B站弹幕Protobuf消息的JSON定义。
             * 这是解码 seg.so 文件的“说明书”。
             * @returns {object} Protobuf的JSON描述对象。
             */
    function getDanmakuProtoDefinition() {
        return {
            "nested": {
                "bilibili": {
                    "nested": {
                        "community": {
                            "nested": {
                                "service": {
                                    "nested": {
                                        "dm": {
                                            "nested": {
                                                "v1": {
                                                    "nested": {
                                                        "DmSegMobileReply": {
                                                            "fields": {
                                                                "elems": {
                                                                    "rule": "repeated",
                                                                    "type": "DanmakuElem",
                                                                    "id": 1
                                                                }
                                                            }
                                                        },
                                                        "DanmakuElem": {
                                                            "fields": {
                                                                "id": { "type": "int64", "id": 1 },
                                                                "progress": { "type": "int32", "id": 2 },
                                                                "mode": { "type": "int32", "id": 3 },
                                                                "fontsize": { "type": "int32", "id": 4 },
                                                                "color": { "type": "uint32", "id": 5 },
                                                                "midHash": { "type": "string", "id": 6 },
                                                                "content": { "type": "string", "id": 7 },
                                                                "ctime": { "type": "int64", "id": 8 },
                                                                "weight": { "type": "int32", "id": 9 },
                                                                "action": { "type": "string", "id": 10 },
                                                                "pool": { "type": "int32", "id": 11 },
                                                                "idStr": { "type": "string", "id": 12 }
                                                            }
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        };
    }


    /**
             * (核心) 解码 Protobuf 格式的弹幕数据。
             * @param {ArrayBuffer} arrayBuffer - 从 seg.so 文件获取的原始二进制数据。
             * @returns {Promise<Array<object>|null>} 返回一个包含弹幕对象的数组，或在失败时返回null。
             */
    async function decodeDanmakuSo(arrayBuffer) {
        if (!decodeDanmakuSo.protoRoot) {
            try {
                const protoJson = getDanmakuProtoDefinition();
                decodeDanmakuSo.protoRoot = Root.fromJSON(protoJson);
            } catch (e) {
                console.error("❌ 加载弹幕 Protobuf 定义失败:", e);
                return null;
            }
        }
        try {
            const DmSegMobileReply = decodeDanmakuSo.protoRoot.lookupType("bilibili.community.service.dm.v1.DmSegMobileReply");
            const decodedMessage = DmSegMobileReply.decode(new Uint8Array(arrayBuffer));
            const resultObject = DmSegMobileReply.toObject(decodedMessage, { defaults: true });
            return resultObject.elems || [];
        } catch (e) {
            console.error("❌ Protobuf 弹幕解码失败:", e);
            return null;
        }
    }


    /** (最终版) 处理解码后的弹幕数组，并将其送入弹幕分析引擎。*/
    function processDecodedDanmakus(danmakus) {
        if (!danmakus || danmakus.length === 0) return;
        debuglog(`🔓弹幕: ${danmakus.length}`);
        let count = 0;
        for (const dm of danmakus) {
            const text = dm.content;
            if (!text) continue;
            if (ANALYZE_DNAMAKU && ANALYZE_DNAMAKU === text) {
                count ++;
            }
            const result = extractTimestamps(text);
            if (result) {
                const ts = result.timestamp;
                const savedAt = dm.progress / 1000;

                const shouldSave = savedAt >= 15 &&
                      ((ts > savedAt && ts - savedAt <= 240 && ts - savedAt > 10) ||
                       (ts <= savedAt && savedAt - ts < 8));
                if (!shouldSave) continue;

                let clusterKey = null;
                for (const existingTsKey in state.danmakuTimestampStore) {
                    const existingTs = Number(existingTsKey);
                    if (Math.abs(ts - existingTs) <= TIME_GROUP_THRESHOLD) {
                        clusterKey = existingTs;
                        break;
                    }
                }
                if (clusterKey === null) {
                    clusterKey = ts;
                    state.danmakuTimestampStore[clusterKey] = [];
                }

                const occurrence = { savedAt, count: result.isAdTs ? 2 : 1 };
                state.danmakuTimestampStore[clusterKey].push(occurrence);
                debuglog(`📥采集: ${formatTime(savedAt)} -> [${formatTime(ts)}]`);
            }
        }
        if (ANALYZE_DNAMAKU ) {
            debuglog('弹幕匹配数量：', ANALYZE_DNAMAKU, count);
        }
    }

    /** 视频页面特殊机制，无法直接捕获原始数据，有待改进
             * (新增) 核心：处理从API拦截到的评论JSON数据。 */
    async function processTopComment(top_replies) {
        const analysisResult = analyzeCommentJson(top_replies);

        if (!analysisResult) {
            debuglog("评论数据中，未找到有效的UP主置顶评论。");
            state.commentAnalysisResult = { hasAd: false, commentText: '', goods: '' };
            return;
        }

        state.commentAnalysisResult = {
            hasAd: analysisResult.hasAd,
            commentText: analysisResult.commentText,
            goods: analysisResult.goods
        };

        log(`  -> 评论区API(拦截器)分析结论: hasAd = ${analysisResult.hasAd}, 商品 = ${analysisResult.goods || '无'}`);
    }


    /** 处理从API拦截到的原始AI字幕JSON数据。*/
    function processSubtitleJson(subtitleJson) {
        if (!subtitleJson || !Array.isArray(subtitleJson.body) || subtitleJson.body.length === 0) {
            log('🚫 无效的AI字幕JSON数据或字幕内容为空。');
            return [];
        }

        debuglog(`✅ 解析AI字幕 ${subtitleJson.body.length} 条`);

        const formattedSubtitles = subtitleJson.body.map(item => {
            const startStr = formatTimeTenths(item.from);
            const endStr = formatTimeTenths(item.to);
            return `${startStr}-${endStr} ${item.content}`;
        });

        return formattedSubtitles;
    }


    /**  * (核心接口) 统一获取B站 /x/web-interface/view API的数据。 带cookie     */
    const fetchVideoViewData = (() => {
        // 创建一个在此函数作用域内持久存在的私有会话缓存
        const viewApiCache = new Map();

        return async function({ bvid, aid }) {
            if (!bvid && !aid) {
                console.error("[ViewAPI] 必须提供 bvid 或 aid。");
                return null;
            }

            // 1. 确定API URL和缓存键
            const isByBvid = !!bvid;
            const cacheKey = isByBvid ? `bvid_${bvid}` : `aid_${aid}`;
            const apiUrl = `https://api.bilibili.com/x/web-interface/view?${isByBvid ? `bvid=${bvid}` : `aid=${aid}`}`;

            // 2. 检查会话缓存
            if (viewApiCache.has(cacheKey)) {
                return viewApiCache.get(cacheKey);
            }

            // 3. 发送网络请求
            try {
                // 【核心修复】添加 credentials: 'include' 选项，强制fetch请求携带Cookie
                const response = await fetch(apiUrl, { credentials: 'include' });
                if (!response.ok) {
                    throw new Error(`请求失败，状态码: ${response.status}`);
                }
                const result = await response.json();
                if (result.code !== 0) {
                    if (result.code === -404 || result.code === 62002) {
                        debuglog(`[ViewAPI] 视频 ${bvid || aid} 不可见 (code: ${result.code})`);
                    } else {
                        console.warn(`[ViewAPI] API for ${bvid || aid} 返回错误: ${result.message}`);
                    }
                    return null;
                }

                const videoData = result.data;
                if (videoData) {
                    // 4. 成功后，将结果存入缓存
                    viewApiCache.set(cacheKey, videoData);
                    return videoData;
                } else {
                    throw new Error('API响应中未找到 data 字段');
                }
            } catch (error) {
                console.error(`[ViewAPI] 请求 ${apiUrl} 时发生错误:`, error);
                return null;
            }
        };
    })();


    /** (GM存储版) 辅助函数：通过视频信息API获取评论区所需的 OID。 */
    async function getOidFromApi(bvid) {
        if (!bvid) return null;

        try {
            let cachedData = await GM_getValue(bvid, {});
            if (typeof cachedData === 'string') {
                try { cachedData = JSON.parse(cachedData); } catch(e) { cachedData = {}; }
            }

            if (cachedData && cachedData.aid) {
                return cachedData.aid.toString();
            }

            // 2. 缓存未命中，调用统一接口
            const data = await fetchVideoViewData({ bvid });
            if (data && data.aid) {
                const oidStr = data.aid.toString();
                cachedData.aid = oidStr;
                await GM_setValue(bvid, cachedData);

                return oidStr;
            }
        } catch (e) {
            console.error(`[getOidFromApi] 操作 GM 存储或请求失败:`, e);
        }

        console.error(`[getOidFromApi] 未能为 ${bvid} 获取到 OID`);
        return null;
    }

    /** * (带详细日志) 通过模拟B站客户端的加载逻辑，获取一个视频的全部弹幕。 */
    async function fetchAllDanmaku({ aid, cid, duration, danmakuCount, segmentLimit = Infinity }) {
        if (!aid || !cid || !duration) {
            console.error("[DanmakuFetcher] 必须提供 aid, cid, 和 duration。");
            return [];
        }

        // 使用Map进行去重，key为弹幕的idStr，value为弹幕对象
        const allDanmakuMap = new Map();
        const segmentDuration = 360; // B站每个弹幕分段的标准时长为6分钟 (360秒)
        const totalSegments = Math.ceil(duration / segmentDuration);
        const effectiveTotalSegments = Math.min(totalSegments, segmentLimit);
        //随机暂停，50~100ms

        log(`🤫 [弹幕] 获取前 ${effectiveTotalSegments } 个分包 (时长: ${formatTime(duration)})`);

        // 创建一个可重用的、用于获取单个弹幕分片的内部函数
        const fetchAndProcessSegment = async (segmentIndex, startTimeMs, endTimeMs) => {
            try {
                const baseParams = {
                    type: 1,
                    oid: cid,
                    pid: aid,
                    segment_index: segmentIndex,
                    web_location: gState.deviceFingerprint?.web_location || 1315873
                };

                // 只有在提供了起始和结束时间时，才加入参数
                if (startTimeMs !== undefined && endTimeMs !== undefined) {
                    baseParams.ps = startTimeMs;
                    baseParams.pe = endTimeMs;
                    baseParams.pull_mode = 1; // 模仿B站逻辑
                }

                const signedParams = await wbiSigner.sign(baseParams);

                const apiUrl = new URL('https://api.bilibili.com/x/v2/dm/wbi/web/seg.so');
                for (const key in signedParams) {
                    apiUrl.searchParams.set(key, signedParams[key]);
                }

                const response = await gState.originalFetch.call(gState.pageWindow, apiUrl.toString(), { credentials: 'include' });
                if (!response.ok) throw new Error(`API response not OK: ${response.status}`);

                const buffer = await response.arrayBuffer();
                const decodedElems = await decodeDanmakuSo(buffer);

                // 【核心新增】详细日志输出
                let logContext = `${segmentIndex}`;
                if (startTimeMs !== undefined) {
                    logContext += `(${startTimeMs / 1000}-${endTimeMs / 1000})`;
                } else {
                    logContext += ``;
                }
                const receivedCount = decodedElems ? decodedElems.length : 0;
                log(`-> [弹幕] 分包 ${logContext}: %c${receivedCount}%c 条`, 'color: #3498db; font-weight: bold;', 'color: initial;');


                if (decodedElems && decodedElems.length > 0) {
                    decodedElems.forEach(elem => {
                        if (elem.idStr && !allDanmakuMap.has(elem.idStr)) {
                            allDanmakuMap.set(elem.idStr, elem);
                        }
                    });
                }
            } catch (err) {
                let errorContext = `分包 ${segmentIndex}`;
                if (startTimeMs !== undefined) errorContext += ` (时间: ${startTimeMs/1000}s-${endTimeMs/1000}s)`;
                console.error(`[DanmakuFetcher] 获取弹幕 ${errorContext} 时失败:`, err);
            }
        };

        // 【核心修复】将 Promise.all 并发模型，修改为 for...await 的串行模型
        const initialSegmentDuration = 120;
        // 1. 请求分包1
        if (effectiveTotalSegments >= 1) {
            if (duration > 0) {
                await fetchAndProcessSegment(1, 0, initialSegmentDuration * 1000);
                await randomSleep(75, 25);
            }
            if (duration > initialSegmentDuration) {
                await fetchAndProcessSegment(1, initialSegmentDuration * 1000, segmentDuration * 1000);
                await randomSleep(75, 25);
            }
        }

        // 2. 循环请求后续分包，直到达到上限
        for (let i = 2; i <= effectiveTotalSegments; i++) {
            await fetchAndProcessSegment(i);
            if (i < effectiveTotalSegments) {
                await randomSleep(75, 25);
            }
        }

        const allDanmakuElems = Array.from(allDanmakuMap.values());
        log(`✅ [弹幕] 共获取 ${allDanmakuElems.length}/${danmakuCount || 'unknown'} 条`);

        return allDanmakuElems;
    }

    /**
             * (全新精简版) 通过B站官方API获取视频评论区数据。
             * - 使用无需WBI签名的 /x/v2/reply 接口。
             * - 依赖 Cookie (SESSDATA) 进行认证。
             */
    async function fetchBilibiliComments({aid}) {
        if (!aid) {
            console.error("[fetchBilibiliComments] 必须提供 aid。");
            return null;
        }
        // --- 主函数逻辑 ---
        try {
            const oid = aid.toString();

            // 步骤 2: 构造新的、简单的 API 请求 URL
            const apiUrl = new URL('https://api.bilibili.com/x/v2/reply');

            // 添加必要的URL参数
            apiUrl.searchParams.set('oid', oid);
            apiUrl.searchParams.set('type', '1');
            apiUrl.searchParams.set('sort', '1');// num	排序方式	非必要	默认为0，0：按时间，1：按点赞数，2：按回复数
            //apiUrl.searchParams.set('mode', '3');
            //apiUrl.searchParams.set('pn', '1');
            //apiUrl.searchParams.set('ps', '20');

            // 步骤 3: 发送请求 (无需任何 WBI 或 自定义 Header)
            // 需要附加 Cookie (SESSDATA)
            const response = await fetch(apiUrl.toString(),{
                credentials: 'include'
            });

            if (!response.ok) {
                throw new Error(`请求评论API失败: ${response.status}`);
            }

            const data = await response.json();
            if (data.code !== 0) {
                throw new Error(`评论API返回错误: ${data.message} (code: ${data.code})`);
            }

            debuglog('✅ 评论数据: ', data.data);
            return data.data;

        } catch (error) {
            console.error(`[fetchBilibiliComments] 发生错误:`, error);
            return null;
        }
    }

    // --- WBI 签名模块 ---
    const wbiSigner = {
        // 缓存 WBI keys
        wbiKeys: null,
        // 1. 获取 img_key 和 sub_key
        async getWbiKeys() {
            // 检查缓存
            const cacheKey = 'bili_wbi_keys';
            const cachedData = localStorage.getItem(cacheKey);
            if (cachedData) {
                const { keys, timestamp } = JSON.parse(cachedData);
                // 缓存有效期6小时
                if (Date.now() - timestamp < 6 * 60 * 60 * 1000) {
                    this.wbiKeys = keys;
                    return keys;
                }
            }

            try {
                const response = await fetch('https://api.bilibili.com/x/web-interface/nav');
                if (!response.ok) throw new Error('获取WBI密钥失败');
                const { data } = await response.json();

                const imgUrl = data.wbi_img.img_url;
                const subUrl = data.wbi_img.sub_url;

                const keys = {
                    imgKey: imgUrl.substring(imgUrl.lastIndexOf('/') + 1, imgUrl.lastIndexOf('.')),
                    subKey: subUrl.substring(subUrl.lastIndexOf('/') + 1, subUrl.lastIndexOf('.')),
                };

                this.wbiKeys = keys;
                localStorage.setItem(cacheKey, JSON.stringify({ keys, timestamp: Date.now() }));

                return keys;
            } catch (error) {
                console.error('获取WBI密钥时出错:', error);
                return null;
            }
        },

        // 2. 实现文档中的 getMixinKey 算法
        getMixinKey(imgKey, subKey) {
            const mixinKeyEncTab = [
                46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
                33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
                61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
                36, 20, 34, 44, 52
            ];
            const s = imgKey + subKey;
            let mixinKey = '';
            for (const i of mixinKeyEncTab) {
                mixinKey += s[i];
            }
            return mixinKey.slice(0, 32);
        },

        // 3. 主签名函数
        async sign(params) {
            if (!this.wbiKeys) {
                await this.getWbiKeys();
            }
            if (!this.wbiKeys) {
                throw new Error("无法获取WBI密钥，无法签名");
            }

            const mixinKey = this.getMixinKey(this.wbiKeys.imgKey, this.wbiKeys.subKey);
            const currTime = Math.round(Date.now() / 1000);

            const signedParams = { ...params, wts: currTime };

            // 排序并编码
            const query = Object.keys(signedParams)
            .sort()
            .map(key => {
                // 过滤特殊字符
                const value = signedParams[key].toString().replace(/[!'()*]/g, '');
                return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
            })
            .join('&');

            const w_rid = window.md5(query + mixinKey);

            return { ...signedParams, w_rid };
        }
    };


    /**
             * (最终版-签名版) 通过B站官方API获取视频评论区数据。
             * @returns {Promise<object|null>} 成功时返回评论API的data对象，失败时返回null。
             */
    async function fetchBilibiliComments_WBI({ aid }) {
        if (!aid) {
            console.error("[fetchBilibiliComments_WBI] 必须提供 aid。");
            return null;
        }

        try {
            const oid = aid.toString();
            const baseParams = {
                oid: oid,
                type: 1,
                mode: 3,
                //pagination_str: JSON.stringify({ offset: "" }),
                plat: 1,
            };
            /*
                        oid	     num	 目标评论区 id	必要
                        type    num	    评论区类型代码	必要	类型代码：1视频稿件；2话题 ；4活动；12专栏
                        mode  num	  排序方式	非必要	默认为 3：仅按热度            1：按热度+按时间            2：仅按时间
                        next    num	     翻页	非必要	不推荐, 已弃用, 优先级比 pagination_str 高
                        plat     num	 平台类型	非必要	如 1
                        pagination_str	obj	分页信息	非必要
                        */
            const signedParams = await wbiSigner.sign(baseParams);
            const apiUrl = new URL('https://api.bilibili.com/x/v2/reply/wbi/main');
            for (const key in signedParams) {
                apiUrl.searchParams.set(key, signedParams[key]);
            }

            const response = await gState.originalFetch(apiUrl.toString());
            if (!response.ok) {
                throw new Error(`请求评论API失败，状态码: ${response.status}`);
            }

            const data = await response.json();
            if (data.code !== 0) {
                throw new Error(`评论API返回错误: ${data.message} (code: ${data.code})`);
            }

            // 返回完整的响应，让调用者自己决定用 data.data
            return data;

        } catch (error) {
            console.error(`[fetchBilibiliComments_WBI] 发生错误:`, error);
            return null;
        }
    }

    // --- 核心功能：Fetch 拦截 ---
    function hookFetch() {
        if (gState.isFetchHooked) return;
        const pageWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
        const origin = pageWindow.fetch;
        if (!origin) {
            debuglog(`pageWindow.fetch is not available.`);
            return;
        }

        gState.originalFetch = origin.bind(pageWindow);

        pageWindow.fetch = function(url, options) {
            const fetchPromise = origin.apply(pageWindow, arguments);
            const isSpaceVideoAPI = url && typeof url === 'string' && url.includes("/x/space/wbi/arc/search");
            if (isSpaceVideoAPI) {
                debuglog(`抓取页面请求设备指纹...`);
                try {
                    const fullUrl = url.startsWith('//') ? 'https:' + url : url;
                    const urlParams = new URL(fullUrl).searchParams;
                    gState.deviceFingerprint = {
                        dm_img_list: urlParams.get('dm_img_list') || '[]',
                        dm_img_str: urlParams.get('dm_img_str') || '',
                        dm_cover_img_str: urlParams.get('dm_cover_img_str') || '',
                        dm_img_inter: urlParams.get('dm_img_inter') || '{}',
                        web_location: urlParams.get('web_location') || ''
                    };
                    //debuglog(`获取设备指纹成功:`, gState.deviceFingerprint);
                    localStorage.setItem('biliAdSkip_deviceFingerprint_cache', JSON.stringify(gState.deviceFingerprint));
                    debuglog(' -> 已缓存设备指纹到 localStorage');
                } catch (err) {
                    console.error(`获取设备指纹失败:`, err);
                }
            }
            return fetchPromise;
        };

        gState.isFetchHooked = true;
        debuglog(`Fetch hooked successfully.`);
    }

    // --- 新增：封装 GM_xmlhttpRequest 以绕过 CSP ---
    function gmFetch(url, options = {}) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                url: url,
                method: options.method || 'GET',
                headers: options.headers || {},
                data: options.body,
                onload: (response) => {
                    resolve({
                        ok: response.status >= 200 && response.status < 300,
                        status: response.status,
                        statusText: response.statusText,
                        text: () => Promise.resolve(response.responseText),
                        json: () => Promise.resolve(JSON.parse(response.responseText))
                    });
                },
                onerror: (error) => reject(error)
            });
        });
    }

    /** 【网络拦截器】 - 最终诊断版 */
    function installNetworkInterceptor() {
        if (window.isUltimateInterceptorInstalled) {
            return;
        } else {
            window.isUltimateInterceptorInstalled = true;
        }

        try {
            const originalXHR_open = window.XMLHttpRequest.prototype.open;
            const originalXHR_send = window.XMLHttpRequest.prototype.send;

            window.XMLHttpRequest.prototype.open = function(method, url, ...args) {
                this._url = url;
                return originalXHR_open.apply(this, [method, url, ...args]);
            };

            window.XMLHttpRequest.prototype.send = function(...args) {
                this.addEventListener('load', async function() {
                    if (typeof this._url === 'string') {
                        if (this._url.includes('api.bilibili.com/x/v2/dm/wbi/web/seg.so')) {
                            //log(`✅ 捕获【弹幕】请求...`);
                            if (this.response instanceof ArrayBuffer) {
                                const decoded = await decodeDanmakuSo(this.response);
                                if (decoded) await processDecodedDanmakus(decoded);
                            }
                        } else if (this._url.includes('api.bilibili.com/x/v2/reply/wbi/main')) {
                            log(`✅ 捕获’评论‘请求...`);
                            try {
                                const commentJson = JSON.parse(this.responseText);
                                const top_replies = commentJson?.data?.top_replies;
                                await processTopComment(top_replies);
                            } catch (e) {
                                console.error("❌ XHR解析评论JSON失败:", e);
                            }
                        } else if (this._url.includes('aisubtitle.hdslb.com/bfs/ai_subtitle/')) {
                            debuglog(`✅ 捕获’字幕‘请求...`);
                            try {
                                const subtitleJson = JSON.parse(this.responseText);
                                const formattedSubtitles = processSubtitleJson(subtitleJson);

                                if (subtitlePromiseResolver) {
                                    subtitlePromiseResolver(formattedSubtitles);
                                    subtitlePromiseResolver = null;
                                }
                            } catch (e) {
                                console.error("❌ (XHR) 解析AI字幕JSON失败:", e);
                                if (subtitlePromiseResolver) {
                                    subtitlePromiseResolver([]);
                                    subtitlePromiseResolver = null;
                                }
                            }
                        }
                    }
                });
                return originalXHR_send.apply(this, args);
            };
        } catch (e) {
            console.error(`安装XHR拦截器失败:`, e);
        }
    }

    async function fetchConfigFromGit() {
        let lastError = null;
        const gitMirror = [
            'https://cdn.jsdelivr.net/gh/chemhunter/biliadskip@main/biliadwordslinks.json',
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
                    debuglog(`✅ 从git镜像: ${source} 获取到广告基础配置`);
                    return configData;
                } catch (parseError) { throw new Error(`JSON解析失败: ${parseError.message}`); }
            } catch (error) { lastError = error; continue;}
        }

        throw new Error(`所有镜像源均无法访问: ${lastError?.message || '未知错误'}`);
    }

    async function getConfigWithFallback(maxRetries = 1) {
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
                await randomSleep(500 * attempt);
            }
        }
        return;
    }

    async function getScriptLocalConfig() {
        const getStoredConfig = async () => {
            try {
                // GM_getValue 直接支持对象，无需 JSON.parse
                return await GM_getValue("localConfig", null);
            } catch (error) {
                console.error('解析存储配置失败:', error);
                return null;
            }
        }

        try {
            let localConfig = await getStoredConfig();
            const lastUpdatePassed = Date.now() - (localConfig?.time || 0);
            const oneDayLong = 24 * 3600 * 1000;
            if (lastUpdatePassed > oneDayLong * 3) {
                log('每三天备份一次GM存储');
                await exportAllDataAsJson();
            }

            let fetchSuccess = false;
            if (FORCE_GIT_CONFIG || lastUpdatePassed > oneDayLong) {
                const res = await getConfigWithFallback();
                if (res) {
                    debuglog(`⚙️ 云端配置更新成功:`, res);
                    biliAdWordsConfig = {
                        ...res,
                        keywordStr: Object.values(res.keywordStr).join('|'),
                        time: Date.now()
                    };
                    await GM_setValue("localConfig", biliAdWordsConfig);
                    fetchSuccess = true;
                } else {
                    log('⚠️ 云端配置获取失败，将回退使用本地或默认配置');
                }
            }

            if (!fetchSuccess) {
                log(`📁 使用本地/默认广告词配置`);
                if (localConfig && localConfig.time && localConfig.keywordStr) {
                    biliAdWordsConfig = localConfig;
                } else {
                    biliAdWordsConfig = defaultConfig;
                    await GM_setValue("localConfig", defaultConfig);
                }
            }
        } catch (error) {
            console.error('配置加载流程异常，使用兜底默认配置:', error);
            biliAdWordsConfig = defaultConfig;
        }

        const safeKeywordStr = biliAdWordsConfig?.keywordStr || defaultConfig.keywordStr;
        keywordRegex = new RegExp(safeKeywordStr.replace(/\s+/g, ''), 'i');
    }


    // =================================================
    // =========== 智能数据迁移模块 (支持合并) ===========
    // =================================================
    async function migrateLocalStorageToGM() {
        if (localStorage.getItem('bili_ls_migrated_v2')) return;
        log(`📦 [${location.hostname}] 检测到未迁移数据，开始增量合并到数据库...`);
        let count = 0;
        let mergeCount = 0;
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith('BV')) {
                try {
                    const lsValStr = localStorage.getItem(key);
                    if (!lsValStr) continue;
                    const lsData = JSON.parse(lsValStr);
                    let gmData = await GM_getValue(key, null);
                    if (gmData && typeof gmData === 'string') {
                        try { gmData = JSON.parse(gmData); } catch(e){}
                    }
                    if (!gmData) {
                        await GM_setValue(key, lsData);
                        count++;
                    } else {
                        let needsUpdate = false;
                        if (lsData.aid && !gmData.aid) {
                            gmData.aid = lsData.aid;
                            needsUpdate = true;
                        }
                        if (lsData.timestamps) {
                            if (!gmData.timestamps) gmData.timestamps = {};
                            for (const source in lsData.timestamps) {
                                if (!gmData.timestamps[source]) {
                                    gmData.timestamps[source] = lsData.timestamps[source];
                                    needsUpdate = true;
                                }
                            }
                        }
                        if (lsData.noAd && !gmData.noAd && !gmData.timestamps) {
                            gmData.noAd = true;
                            needsUpdate = true;
                        }
                        if (needsUpdate) {
                            await GM_setValue(key, gmData);
                            mergeCount++;
                        }
                    }
                    keysToRemove.push(key);
                } catch (e) {
                    console.error('迁移合并失败:', key, e);
                }
            }
        }

        keysToRemove.forEach(key => localStorage.removeItem(key));
        localStorage.setItem('bili_ls_migrated_v2', 'true');

        if (count > 0 || mergeCount > 0) {
            log(`✅ [${location.hostname}] 迁移完成！新增: ${count} 条，合并/补全: ${mergeCount} 条。`);
        } else {
            log(`✅ [${location.hostname}] 检查完成，无需迁移。`);
        }
    }

    async function main() {
        log('🚀 执行脚本主程序...')
        await getScriptLocalConfig();
        const Mode = await determineMode();
        await loadDataForCurrentMode(Mode);
        await executeMainLogic(Mode);
        log('✅ 初始化流程执行完毕');
    }

    hookFetch();
    installNetworkInterceptor();
    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', main, { once: true });
    } else {
        main();
    }

    registerMenuUI("🤖管理AI配置", 'bili-ad-skipper-ai-config-popup', setupAiConfigUI);
    registerMenuUI("⌚管理时间戳", 'bili-ad-timestamp-editor', manualAdTimestamps);
    registerMenuUI("📋管理白名单", 'UpWhiteListContainer', monitorUpWhiteList);

})();
