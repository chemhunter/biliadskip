// ==UserScript==
// @name         圈小猫智能辅助
// @namespace    catch-the-cat__toll
// @version      1.4
// @description  圈小猫辅助：猫猫最短路径预测、猫猫行动轨迹、首步落子推荐、无限制悔棋、自定义地图编辑（初始2~10障碍物）。
// @author       Gemini 3.0
// @match        www.52pojie.cn/404.*
// @match        https://catch-the-cat.dujun.art/
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // === 开关配置 ===
    const SHOW_WALL_VALUE = false; // 设置为 false 即可隐藏预置墙的价值分数字
    const INIT_WALL_NUM_MIN = 2; // 编辑模式下初始障碍数量下限
    const INIT_WALL_NUM_MAX = 10; // 编辑模式下初始障碍数量上限

    // ================= UI与样式 =================
    const style = document.createElement('style');
    style.innerHTML = `
        /* 按钮容器 */
        .cat-btn-group {
            position: absolute;
            bottom: 0; /* 1. 底部边缘对齐 */
            left: 50%;
            /* 2. 水平居中(-50%)，且垂直向下偏移自身高度的50%(50%)，从而达成“骑在线上”的效果 */
            transform: translate(-50%, 50%);
            z-index: 9999;
            display: flex;
            gap: 15px;
            align-items: center;
            justify-content: center;
            /* 3. 增加一点底部外边距，防止贴得太死（可选，视具体手机效果而定） */
            padding-bottom: 2px;
        }
        .cat-btn {
            color: white; border: none; padding: 8px 18px;
            font-weight: bold; border-radius: 20px; cursor: pointer;
            box-shadow: 0 4px 10px rgba(0,0,0,0.3);
            transition: all 0.2s; font-family: "Microsoft YaHei", sans-serif;
            font-size: 14px; white-space: nowrap;
        }
        /* 悬停效果保持不变，因为是作用在子元素上的，不会冲突 */
        .cat-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 15px rgba(0,0,0,0.4); }
        #cat-undo { background: orange; display: none; }
        #cat-edit { background: #FF9800; }
        #catch-the-cat { position: relative !important; }
    `;
    document.head.appendChild(style);

    // 创建容器
    const btnContainer = document.createElement('div');
    btnContainer.className = 'cat-btn-group';

    // 创建按钮
    const btnUndo = document.createElement('button');
    btnUndo.id = 'cat-undo';
    btnUndo.className = 'cat-btn';
    btnUndo.innerHTML = '⏪ 悔棋';

    const btnEdit = document.createElement('button');
    btnEdit.id = 'cat-edit';
    btnEdit.className = 'cat-btn';
    btnEdit.innerHTML = '🛠️ 编辑模式';

    // 组装
    btnContainer.appendChild(btnUndo);
    btnContainer.appendChild(btnEdit);

    // ================= 核心变量 =================
    let historyStack = [];
    let stepTextObjects = [];
    let wallValueTextObjects = [];
    let catHistoryPath = [];
    let globalStepCount = 1;
    let debugGraphics = null;
    let historyGraphics = null;
    let isEditing = false;

    const COLOR_WALL_PRESET = 13158;    // 深蓝
    const COLOR_EMPTY = 11786751;       // 浅蓝
    const COLOR_PLAYER = 0xff6600;      // 玩家橙色

    // ================= 基础算法 =================
    function getNeighbours(t, e) {
        const isEvenRow = (e & 1) === 0;
        let n = [];
        n.push({ i: t - 1, j: e });
        n.push({ i: t + 1, j: e });
        if (isEvenRow) {
            n.push({ i: t - 1, j: e - 1 });
            n.push({ i: t, j: e - 1 });
            n.push({ i: t - 1, j: e + 1 });
            n.push({ i: t, j: e + 1 });
        } else {
            n.push({ i: t, j: e - 1 });
            n.push({ i: t + 1, j: e - 1 });
            n.push({ i: t, j: e + 1 });
            n.push({ i: t + 1, j: e + 1 });
        }
        return n;
    }

    function getDistanceMap(blocks, startPoints, w, h) {
        let distMap = Array(w).fill(0).map(() => Array(h).fill(Infinity));
        let queue = [];
        for (let p of startPoints) {
            if (p.i>=0 && p.i<w && p.j>=0 && p.j<h) {
                distMap[p.i][p.j] = 0;
                queue.push(p);
            }
        }
        while (queue.length > 0) {
            let curr = queue.shift();
            let d = distMap[curr.i][curr.j];
            for (let n of getNeighbours(curr.i, curr.j)) {
                if (n.i < 0 || n.i >= w || n.j < 0 || n.j >= h) continue;
                if (blocks[n.i][n.j]) continue;
                if (distMap[n.i][n.j] === Infinity) {
                    distMap[n.i][n.j] = d + 1;
                    queue.push(n);
                }
            }
        }
        return distMap;
    }

    function getShortestPathPoints(blocks, cat, w, h) {
        const distMap = getDistanceMap(blocks, [cat], w, h);
        let minL = Infinity;
        let edgePoints = [];
        for(let x=0; x<w; x++) for(let y=0; y<h; y++) {
            if((x===0 || x===w-1 || y===0 || y===h-1) && !blocks[x][y]) {
                if(distMap[x][y] < minL) { minL = distMap[x][y]; edgePoints = [{i:x, j:y}]; }
                else if(distMap[x][y] === minL) { edgePoints.push({i:x, j:y}); }
            }
        }
        let pathSet = new Set();
        if(minL === Infinity) return pathSet;

        for(let target of edgePoints) {
            let queue = [target];
            let visited = new Set();
            visited.add(`${target.i},${target.j}`);
            while(queue.length > 0){
                let curr = queue.shift();
                pathSet.add(`${curr.i},${curr.j}`);
                if(distMap[curr.i][curr.j] === 1) continue;
                let ns = getNeighbours(curr.i, curr.j);
                for (let n of ns) {
                    if (n.i>=0 && n.i<w && n.j>=0 && n.j<h && !blocks[n.i][n.j]) {
                        if (distMap[n.i][n.j] === distMap[curr.i][curr.j] - 1) {
                            let key = `${n.i},${n.j}`;
                            if(!visited.has(key)){
                                visited.add(key);
                                queue.push(n);
                            }
                        }
                    }
                }
            }
        }
        return pathSet;
    }

    function evaluateWallValue(i, j, catI, catJ, w, h) {
        let val = 1.0;
        let rowDist = Math.abs(j - catJ);
        val += rowDist * 0.5;
        let centerCol = Math.floor(w / 2);
        let colDist = Math.abs(i - centerCol);
        val += (5 - colDist) * 0.5;
        if (j === 0 || j === h - 1) val += 3.0;
        return val;
    }

    // ================= 核心：第一步推荐算法 =================
    function getFirstStepSuggestion(scene) {
        const w = scene.w;
        const h = scene.h;
        const cat = { i: scene.cat.i, j: scene.cat.j };

        let blocks = [];
        for(let x=0; x<w; x++){ blocks[x]=[]; for(let y=0; y<h; y++) blocks[x][y] = scene.blocks[x][y].isWall; }

        let rightZoneEmpty = true;
        let checkCount = 0;

        for(let x = cat.i + 1; x <= Math.min(w-1, cat.i + 4); x++) {
            for(let y = cat.j - 2; y <= cat.j + 2; y++) {
                if(y >= 0 && y < h) {
                    checkCount++;
                    if(blocks[x][y]) {
                        rightZoneEmpty = false;
                        break;
                    }
                }
            }
            if(!rightZoneEmpty) break;
        }

        if(rightZoneEmpty && checkCount > 0 && cat.i < w - 3) {
            console.log("触发 Rule 3: 右侧真空必杀");
            return { i: cat.i + 2, j: cat.j };
        }

        const pathSet = getShortestPathPoints(blocks, cat, w, h);
        const distMap = getDistanceMap(blocks, [cat], w, h);

        let scoreTop = 0;
        let scoreBottom = 0;
        for (let i = 0; i < w; i++) {
            for (let j = 0; j < h; j++) {
                if (blocks[i][j]) {
                    let val = evaluateWallValue(i, j, cat.i, cat.j, w, h);
                    if (j < cat.j) scoreTop += val;
                    if (j > cat.j) scoreBottom += val;
                }
            }
        }
        let targetDirection = (scoreTop < scoreBottom) ? 'TOP' : 'BOTTOM';

        let candidates = [];
        for (let i = 0; i < w; i++) {
            for (let j = 0; j < h; j++) {
                if (!blocks[i][j] && distMap[i][j] === 2) {
                    if (targetDirection === 'TOP' && j >= cat.j) continue;
                    if (targetDirection === 'BOTTOM' && j <= cat.j) continue;

                    let score = evaluateWallValue(i, j, cat.i, cat.j, w, h);
                    let key = `${i},${j}`;
                    let isOnPath = pathSet.has(key);
                    let ns = getNeighbours(i, j);
                    let hasWallNeighbor = false;
                    for(let n of ns) {
                        if(n.i>=0 && n.i<w && n.j>=0 && n.j<h && blocks[n.i][n.j]) {
                            hasWallNeighbor = true;
                            break;
                        }
                    }
                    candidates.push({ i, j, score, isOnPath, hasWallNeighbor });
                }
            }
        }

        let strictSet = candidates.filter(c => c.isOnPath && !c.hasWallNeighbor);
        if(strictSet.length > 0) return strictSet.sort((a,b) => b.score - a.score)[0];

        let pathSetOnly = candidates.filter(c => c.isOnPath);
        if(pathSetOnly.length > 0) return pathSetOnly.sort((a,b) => b.score - a.score)[0];

        let isoSet = candidates.filter(c => !c.hasWallNeighbor);
        if(isoSet.length > 0) return isoSet.sort((a,b) => b.score - a.score)[0];

        if(candidates.length > 0) return candidates.sort((a,b) => b.score - a.score)[0];

        return null;
    }

    // ================= 绘图逻辑 =================

    function drawAnalysis(scene) {
        if (!scene.add || !scene.add.graphics) return;

        if (!debugGraphics) {
            debugGraphics = scene.add.graphics();
            debugGraphics.setDepth(9999);
        }
        if (!historyGraphics) {
            historyGraphics = scene.add.graphics();
            historyGraphics.setDepth(15000);
        }

        debugGraphics.clear();
        historyGraphics.clear();

        if (catHistoryPath.length >= 2) {
            historyGraphics.lineStyle(4, 0xFF4444, 0.8);
            historyGraphics.beginPath();
            let start = scene.getPosition(catHistoryPath[0].i, catHistoryPath[0].j);
            historyGraphics.moveTo(start.x, start.y);
            for (let k = 1; k < catHistoryPath.length; k++) {
                let p = scene.getPosition(catHistoryPath[k].i, catHistoryPath[k].j);
                historyGraphics.lineTo(p.x, p.y);
            }
            historyGraphics.strokePath();
        }

        let b = [];
        for(let x=0; x<scene.w; x++){ b[x]=[]; for(let y=0; y<scene.h; y++) b[x][y] = scene.blocks[x][y].isWall; }
        const distMap = getDistanceMap(b, [{i:scene.cat.i, j:scene.cat.j}], scene.w, scene.h);

        let minL = Infinity;
        let edgePoints = [];
        for(let x=0; x<scene.w; x++) for(let y=0; y<scene.h; y++) {
            if((x===0 || x===scene.w-1 || y===0 || y===scene.h-1) && !b[x][y]) {
                if(distMap[x][y] < minL) { minL = distMap[x][y]; edgePoints = [{i:x, j:y}]; }
                else if(distMap[x][y] === minL) { edgePoints.push({i:x, j:y}); }
            }
        }

        if(minL !== Infinity) {
            debugGraphics.lineStyle(3, 0xFFFF00, 0.6);
            for(let target of edgePoints) {
                let curr = target;
                let path = [curr];
                let safety = 0;
                while ((curr.i !== scene.cat.i || curr.j !== scene.cat.j) && safety++ < 50) {
                    let ns = getNeighbours(curr.i, curr.j);
                    for (let n of ns) {
                        if (n.i>=0 && n.i<scene.w && n.j>=0 && n.j<scene.h && !b[n.i][n.j]) {
                            if (distMap[n.i][n.j] === distMap[curr.i][curr.j] - 1) {
                                curr = n; path.push(n); break;
                            }
                        }
                    }
                }
                debugGraphics.beginPath();
                let p0 = scene.getPosition(path[0].i, path[0].j);
                debugGraphics.moveTo(p0.x, p0.y);
                for(let k=1; k<path.length; k++){
                    let p = scene.getPosition(path[k].i, path[k].j);
                    debugGraphics.lineTo(p.x, p.y);
                }
                debugGraphics.strokePath();
            }
        }

        // 清理文字
        wallValueTextObjects.forEach(t => t.destroy());
        wallValueTextObjects = [];

        // 只有第一步才显示价值数字和绿圈建议
        if (globalStepCount === 1) {
            if (SHOW_WALL_VALUE) {
                for (let i = 0; i < scene.w; i++) {
                    for (let j = 0; j < scene.h; j++) {
                        if (scene.blocks[i][j].isWall) {
                            let val = evaluateWallValue(i, j, scene.cat.i, scene.cat.j, scene.w, scene.h);
                            let p = scene.getPosition(i, j);
                            let fontSize = Math.floor(scene.r * 0.6);
                            let strokeSize = Math.max(2, Math.floor(scene.r * 0.1));
                            let t = scene.add.text(p.x, p.y, val.toFixed(1), {
                                font: `bold ${fontSize}px Arial`,
                                fill: "#ffffff",
                                stroke: "#000000",
                                strokeThickness: strokeSize
                            });
                            t.setOrigin(0.5);
                            t.setDepth(20001);
                            wallValueTextObjects.push(t);
                        }
                    }
                }
            }

            let suggestion = getFirstStepSuggestion(scene);
            if (suggestion) {
                let p = scene.getPosition(suggestion.i, suggestion.j);
                debugGraphics.lineStyle(4, 0x00FF00, 1);
                debugGraphics.strokeCircle(p.x, p.y, 18);
                debugGraphics.fillStyle(0x00FF00, 0.4);
                debugGraphics.fillCircle(p.x, p.y, 18);
            }
        }
    }

    // ================= 编辑模式逻辑 =================

    // 辅助函数：更新顶部状态栏的墙壁计数
    function updateEditorStatus(scene) {
        let wallCount = 0;
        for(let i=0; i<scene.w; i++) {
            for(let j=0; j<scene.h; j++) {
                if(scene.blocks[i][j].isWall) wallCount++;
            }
        }
        // 调用游戏原生的 setStatusText 方法
        if (scene.setStatusText) {
            scene.setStatusText(`🛠️ 地图编辑模式: 预置障碍 (${wallCount}个)`);
        }
    }

    function toggleEditMode() {
        let scene = findGameScene();
        if(!scene) return;

        isEditing = !isEditing;

        if (isEditing) {
            btnEdit.innerHTML = "💾 保存布局";
            btnEdit.style.background = "#FF9800";
            btnUndo.style.display = 'none'; // 编辑时隐藏悔棋
            updateEditorStatus(scene);      // 立即更新状态栏
        } else {
            // 保存逻辑
            let wallCount = 0;
            for(let i=0; i<scene.w; i++) {
                for(let j=0; j<scene.h; j++) {
                    if(scene.blocks[i][j].isWall) wallCount++;
                }
            }

            if (wallCount < INIT_WALL_NUM_MIN || wallCount > INIT_WALL_NUM_MAX) {
                alert(`保存失败！\n预置障碍数量必须为 ${INIT_WALL_NUM_MIN} ~ ${INIT_WALL_NUM_MAX} 个。\n当前数量：${wallCount}`);
                isEditing = true;
                return;
            }

            // 保存成功
            btnEdit.innerHTML = "🛠️ 编辑模式";
            btnEdit.style.background = "#FF9800";
            btnUndo.style.display = 'none';

            // 恢复游戏默认提示语
            if (scene.setStatusText) {
                scene.setStatusText("点击小圆点，围住小猫");
            }

            // 重置游戏为开局状态
            globalStepCount = 1;
            catHistoryPath = [{i:scene.cat.i, j:scene.cat.j}];
            stepTextObjects.forEach(t => t.destroy());
            stepTextObjects = [];

            drawAnalysis(scene);
        }
    }

    // ================= 游戏注入与悔棋 =================

    function captureGameState(scene) {
        let state = {
            cat: {i: scene.cat.i, j: scene.cat.j},
            blocks: [],
            step: globalStepCount,
            path: [...catHistoryPath]
        };
        for(let i=0; i<scene.w; i++){
            state.blocks[i] = [];
            for(let j=0; j<scene.h; j++) state.blocks[i][j] = scene.blocks[i][j].isWall;
        }
        return state;
    }

    function undo() {
        let scene = findGameScene();
        if(!scene || historyStack.length === 0) return;
        let s = historyStack.pop();
        if(historyStack.length === 0) btnUndo.style.display = 'none';

        scene.cat.i = s.cat.i; scene.cat.j = s.cat.j;
        let p = scene.getPosition(s.cat.i, s.cat.j);
        scene.cat.setPosition(p.x, p.y);
        scene.cat.resetTextureToStop();

        for(let i=0; i<scene.w; i++) for(let j=0; j<scene.h; j++) {
            scene.blocks[i][j].isWall = s.blocks[i][j];
            scene.blocks[i][j].fillColor = s.blocks[i][j] ? COLOR_WALL_PRESET : COLOR_EMPTY;
        }

        globalStepCount = s.step;
        catHistoryPath = s.path;
        if(stepTextObjects.length > 0) stepTextObjects.pop().destroy();

        if (globalStepCount === 1) {
            btnEdit.style.display = 'block';
        }

        scene.state = 'playing';
        drawAnalysis(scene);
    }

    let cachedScene = null;
    function findGameScene() {
        if (cachedScene) return cachedScene;
        if (window.game && window.game.mainScene) return cachedScene = window.game.mainScene;
        for (let key of Object.keys(window)) {
            try {
                if(['frames','self','parent'].includes(key)) continue;
                if(window[key] && window[key].mainScene && window[key].mainScene.cat)
                    return cachedScene = window[key].mainScene;
            } catch(e){}
        }
        return null;
    }

    let isHooked = false;
    function hook() {
        let scene = findGameScene();
        if (!scene || isHooked) return;

        const gameContainer = document.querySelector('#catch-the-cat');
        if (gameContainer && btnContainer.parentElement !== gameContainer) {
            gameContainer.appendChild(btnContainer);
        }

        if(catHistoryPath.length === 0) catHistoryPath.push({i:scene.cat.i, j:scene.cat.j});

        // 劫持点击
        let originalClick = scene.playerClick;
        scene.playerClick = function(i, j) {
            if (isEditing) {
                if(this.cat.i === i && this.cat.j === j) return false;
                let block = this.blocks[i][j];
                block.isWall = !block.isWall;
                block.fillColor = block.isWall ? COLOR_WALL_PRESET : COLOR_EMPTY;
                drawAnalysis(this);
                updateEditorStatus(this);
                return;
            }

            let preMoveState = captureGameState(this);
            let res = originalClick.call(this, i, j);

            if(res) {
                historyStack.push(preMoveState);
                btnUndo.style.display = 'block';
                this.blocks[i][j].fillColor = COLOR_PLAYER;

                btnEdit.style.display = 'none';

                if(wallValueTextObjects.length > 0) {
                    wallValueTextObjects.forEach(t => t.destroy());
                    wallValueTextObjects = [];
                }

                let p = this.getPosition(i, j);
                let fontSize = Math.floor(this.r * 0.75);
                let strokeSize = Math.max(2, Math.floor(this.r * 0.1));
                let t = this.add.text(p.x, p.y, String(globalStepCount++), { font: `900 ${fontSize}px Arial`, fill: "#ffffff", stroke: "#000000", strokeThickness: strokeSize });

                t.setOrigin(0.5); t.setDepth(20000);
                stepTextObjects.push(t);

                setTimeout(() => {
                    catHistoryPath.push({i:this.cat.i, j:this.cat.j});
                    drawAnalysis(this);
                }, 350);
            }
            return res;
        }

        let originalReset = scene.reset;
        scene.reset = function() {
            historyStack = [];
            stepTextObjects.forEach(t => t.destroy());
            stepTextObjects = [];
            wallValueTextObjects.forEach(t => t.destroy());
            wallValueTextObjects = [];

            // 重置状态
            isEditing = false;
            btnEdit.innerHTML = "🛠️ 编辑模式";
            btnEdit.style.background = "#FF9800";
            btnEdit.style.display = 'block';
            btnUndo.style.display = 'none';

            globalStepCount = 1;
            catHistoryPath = [];

            if(debugGraphics) debugGraphics.clear();
            if(historyGraphics) historyGraphics.clear();

            let res = originalReset.apply(this, arguments);
            setTimeout(() => {
                catHistoryPath.push({i:this.cat.i, j:this.cat.j});
                drawAnalysis(this);
            }, 500);
            return res;
        }

        scene.blocks.forEach(col => col.forEach(b => {
            b.removeAllListeners('player_click');
            b.on('player_click', function() { scene.playerClick(this.i, this.j); });
        }));

        isHooked = true;
        setTimeout(() => drawAnalysis(scene), 1000);
    }

    btnUndo.onclick = undo;
    btnEdit.onclick = toggleEditMode;
    setInterval(hook, 1000);

})();
