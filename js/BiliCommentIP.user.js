// ==UserScript==
// @name         Bilibili Comment IP Display
// @name:zh     B站评论区显示归属地
// @namespace    http://tampermonkey.net/
// @version      3.0.2
// @description  Displays IP location in the Bilibili comment section by intercepting API responses.
// @description:zh-CN    B站网页端各个页面评论区显示用户IP归属地
// @author        xxapk & 蓝色空間前进四
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/list/*
// @match        https://www.bilibili.com/medialist/play/ml*
// @match        https://www.bilibili.com/read/cv*
// @match        https://www.bilibili.com/opus/*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://www.bilibili.com/festival/*
// @match        https://space.bilibili.com/*
// @match        https://t.bilibili.com/*
// @match        https://live.bilibili.com/*
// @icon         https://www.bilibili.com/favicon.ico
// @updateURL    https://cdn.jsdelivr.net/gh/chemhunter/biliadskip@main/js/BiliCommentIP.user.js 
// @downloadURL  https://cdn.jsdelivr.net/gh/chemhunter/biliadskip@main/js/BiliCommentIP.user.js 
// @grant        none
// @license    GPL-3.0-only
// @run-at       document-start
// ==/UserScript==

(function() {
    'use strict';

    /*
 * 本脚本是基于B站用户 @xxapk 创建的“评论IP属地楼层号专栏版"的深度重构和简化版本。
 * 原脚本公开地址 https://www.bilibili.com/opus/1029361570497429505

 * 主要改动：
 * 1. 移除了楼层号功能，专注于核心的IP属地显示，大幅精简代码为原来的十分之一。
 * 2. 将核心拦截逻辑从暴力的“js源码注入”重构为更温和的“API拦截”。
 * 3. 对代码进行了规范化和重命名，以提高可读性/兼容性/可维护性。

 * 原始脚本的核心思想和贡献归功于原作者，感谢其开源精神，以及巧妙的实现思路和开创性工作。
 */

    // --- 1. 全局状态与配置 ---

    const SCRIPT_NAME = "BiliCommentIP";

    const gState = {
        originalFetch: null,
        isFetchHooked: false,
        //isAppendHooked: false,
        //isReloadHooked: false
    };

    // --- 核心功能：Fetch 拦截 ---
    function hookFetch() {
        if (gState.isFetchHooked) return;
        const origin = window.fetch;
        if (!origin) {
            console.error(`[${SCRIPT_NAME}] window.fetch is not available.`);
            return;
        }

        gState.originalFetch = origin;

        window.fetch = function(url, options) {
            const fetchPromise = origin(url, options);
            if (!url || typeof url !== 'string') { return fetchPromise };

            const isMainCommentAPI = url.includes("reply/wbi/main");
            const isSubCommentAPI = url.includes("/reply/reply?") && url.includes("&root=");
            if (isMainCommentAPI || isSubCommentAPI) {
                console.log(`[${SCRIPT_NAME}] Intercepted ${isMainCommentAPI ? 'Main' : 'Sub'} Comment API:`, url.substring(0, 100));

                return fetchPromise.then(function(response) {
                    if (!response.ok) {
                        return response;
                    }
                    const clonedResponse = response.clone();

                    // 重写 .json() 方法，这是注入数据的关键
                    response.json = function() {
                        return clonedResponse.json().then(function(result) {
                            return processCommentData(result, isSubCommentAPI);
                        }).catch(function(err) {
                            console.error(`[${SCRIPT_NAME}] Error parsing original JSON:`, err);
                            return Promise.reject(err);
                        });
                    };
                    return response;
                });
            }
            return fetchPromise;
        };

        gState.isFetchHooked = true;
        console.log(`[${SCRIPT_NAME}] Fetch hooked successfully.`);
    }

    // --- 数据处理核心 ---
    function processCommentData(data, isSubCommentAPI = false) {
        if (!data || !data.data) return data;
        let commentsToProcess = [];
        if (isSubCommentAPI) {
            commentsToProcess = [].concat(data.data.root || [], data.data.replies || []);
        } else {
            commentsToProcess = [].concat(data.data.top_replies || [], data.data.replies || []);
        }
        for (let i = 0; i < commentsToProcess.length; i++) {
            const comment = commentsToProcess[i];
            const isSub = isSubCommentAPI || (comment.root > 0);
            injectIpToComment(comment, isSub);
            if (!isSubCommentAPI && comment.replies && comment.replies.length > 0) {
                for (let j = 0; j < comment.replies.length; j++) {
                    injectIpToComment(comment.replies[j], true);
                }
            }
        }
        return data;
    }

    /** 将IP属地信息注入到单个评论对象的 uname 字段中。*/
    function injectIpToComment(comment, isSubReply = false) {
        if (!comment || !comment.reply_control || !comment.member || !comment.member.uname) {
            return;
        }
        const locationRaw = comment.reply_control.location;
        if (locationRaw && typeof locationRaw === 'string') {
            const ipLocation = locationRaw.replace(/IP属地：/ig, "").trim();
            if (ipLocation) {
                const ipText = ` <${ipLocation}>`;
                comment.member.uname += ipText;
            }
        }
    }
    console.log(`[${SCRIPT_NAME}] Script starting...`);
    hookFetch();

})();
