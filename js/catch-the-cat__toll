// ==UserScript==
// @name         圈小猫辅助
// @namespace    catch-the-cat__toll
// @version      1.1
// @description  仅提供：悔棋按钮、路径预测（黄线）、历史记录（红线）、步数显示。
// @author       ChatGPT
// @match        https://www.52pojie.cn/404.html
// @match        https://catch-the-cat.dujun.art/
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // ================= UI与样式 =================
    const style = document.createElement('style');
    style.innerHTML = `
        .cat-btn {
            position: absolute; 
            top: 10px;
            left: 10px;
            z-index: 9999;
            color: white;
            border: none;
            padding: 8px 15px;
            font-weight: bold;
            border-radius: 6px;
            cursor: pointer;
            box-shadow: 0 2px 4px rgba(0,0,0,0.3);
            background:  orange;
            transition: all 0.2s;
            display: none;
        }
        .cat-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 8px rgba(0,0,0,0.3);
        }
        #catch-the-cat {
            position: relative !important;
        }
    `;
    document.head.appendChild(style);

    const btnUndo = document.createElement('button');
    btnUndo.id = 'cat-undo';
    btnUndo.className = 'cat-btn';
    btnUndo.innerHTML = '⏪ 悔棋';

    // ================= 核心变量 =================
    let historyStack = [];
    let stepTextObjects = [];
    let catHistoryPath = [];
    let globalStepCount = 1;
    let debugGraphics = null;
    let historyGraphics = null;

    // ================= 算法辅助函数 =================
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

    function getEdgePoints(blocks, w, h) {
        let arr = [];
        for (let i = 0; i < w; i++) {
            for (let j = 0; j < h; j++) {
                if ((i === 0 || i === w - 1 || j === 0 || j === h - 1) && !blocks[i][j]) {
                    arr.push({ i, j });
                }
            }
        }
        return arr;
    }

    // ================= 绘图逻辑 =================

    function drawCatHistory(scene) {
        if (!historyGraphics && scene.add && scene.add.graphics) {
            historyGraphics = scene.add.graphics();
            historyGraphics.setDepth(15000);
        }
        if (!historyGraphics) return;

        historyGraphics.clear();
        if (catHistoryPath.length < 2) return;

        historyGraphics.lineStyle(4, 0xFF0000, 0.8);
        historyGraphics.beginPath();

        let startPos = scene.getPosition(catHistoryPath[0].i, catHistoryPath[0].j);
        historyGraphics.moveTo(startPos.x, startPos.y);

        for (let k = 1; k < catHistoryPath.length; k++) {
            let p = scene.getPosition(catHistoryPath[k].i, catHistoryPath[k].j);
            historyGraphics.lineTo(p.x, p.y);
        }
        historyGraphics.strokePath();

        let endP = scene.getPosition(catHistoryPath[catHistoryPath.length-1].i, catHistoryPath[catHistoryPath.length-1].j);
        historyGraphics.fillStyle(0xFF0000, 1);
        historyGraphics.fillCircle(endP.x, endP.y, 5);
    }

    function drawPrediction(scene) {
        if (!scene.add || !scene.add.graphics) return;
        if (!debugGraphics) {
            debugGraphics = scene.add.graphics();
            debugGraphics.setDepth(9999);
        }
        debugGraphics.clear();

        let b = [];
        for(let x=0;x<scene.w;x++){ b[x]=[]; for(let y=0;y<scene.h;y++) b[x][y]=scene.blocks[x][y].isWall; }

        const distMap = getDistanceMap(b, [{i:scene.cat.i, j:scene.cat.j}], scene.w, scene.h);
        const edgePoints = getEdgePoints(b, scene.w, scene.h);

        let minL = Infinity;
        for(let e of edgePoints) if(distMap[e.i][e.j] < minL) minL = distMap[e.i][e.j];

        if (minL === Infinity) {
            drawCatHistory(scene);
            return;
        }

        debugGraphics.lineStyle(3, 0xFFFF00, 0.6);
        for(let e of edgePoints) {
            if(distMap[e.i][e.j] === minL) {
                let curr = e;
                let path = [curr];
                let safe = 0;
                while((curr.i!=scene.cat.i || curr.j!=scene.cat.j) && safe++ < 50){
                    let ns = getNeighbours(curr.i, curr.j);
                    let found = false;
                    for(let n of ns) {
                        if(n.i>=0 && n.i<scene.w && n.j>=0 && n.j<scene.h && !b[n.i][n.j]) {
                            if(distMap[n.i][n.j] === distMap[curr.i][curr.j] - 1) {
                                curr = n; path.push(n); found=true; break;
                            }
                        }
                    }
                    if(!found) break;
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
        drawCatHistory(scene);
    }

    // ================= 悔棋系统 =================

    function saveUndoState(scene) {
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
        historyStack.push(state);
        btnUndo.style.display = 'block';
    }

    function undo() {
        let scene = findGameScene();
        if(!scene || historyStack.length === 0) return;

        let s = historyStack.pop();
        if(historyStack.length === 0) btnUndo.style.display = 'none';

        scene.cat.i = s.cat.i;
        scene.cat.j = s.cat.j;
        let p = scene.getPosition(s.cat.i, s.cat.j);
        scene.cat.setPosition(p.x, p.y);
        scene.cat.resetTextureToStop();

        for(let i=0; i<scene.w; i++)
            for(let j=0; j<scene.h; j++) {
                scene.blocks[i][j].isWall = s.blocks[i][j];
                scene.blocks[i][j].fillColor = s.blocks[i][j] ? 13158 : 11786751;
            }

        globalStepCount = s.step;
        catHistoryPath = s.path;

        if(stepTextObjects.length > 0) {
            let lastText = stepTextObjects.pop();
            lastText.destroy();
        }

        scene.state = 'playing';
        drawPrediction(scene);
    }

    // ================= 游戏注入 (Hook) =================

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

        // --- UI 挂载逻辑 ---
        // 寻找游戏容器 div#catch-the-cat
        const gameContainer = document.querySelector('#catch-the-cat');
        if (gameContainer && btnUndo.parentElement !== gameContainer) {
            gameContainer.appendChild(btnUndo);
            console.log("悔棋按钮已挂载到游戏容器");
        }

        // 初始化路径
        if(catHistoryPath.length === 0) catHistoryPath.push({i:scene.cat.i, j:scene.cat.j});

        // 1. 劫持点击
        let originalClick = scene.playerClick;
        scene.playerClick = function(i, j) {
            saveUndoState(this);
            let res = originalClick.call(this, i, j);
            if(res) {
                let p = this.getPosition(i, j);
                let t = this.add.text(p.x, p.y, String(globalStepCount++),
                    { font: "900 16px Arial", fill: "#ffffff", stroke: "#000000", strokeThickness: 3 });
                t.setOrigin(0.5);
                t.setDepth(20000);
                stepTextObjects.push(t);

                setTimeout(() => {
                    catHistoryPath.push({i:this.cat.i, j:this.cat.j});
                    drawPrediction(this);
                }, 350);
            }
            return res;
        }

        // 2. 劫持重置
        let originalReset = scene.reset;
        scene.reset = function() {
            historyStack = [];
            stepTextObjects.forEach(t => t.destroy());
            stepTextObjects = [];
            globalStepCount = 1;
            catHistoryPath = [];
            btnUndo.style.display = 'none';
            if(debugGraphics) debugGraphics.clear();
            if(historyGraphics) historyGraphics.clear();

            let res = originalReset.apply(this, arguments);
            setTimeout(() => {
                catHistoryPath.push({i:this.cat.i, j:this.cat.j});
                drawPrediction(this);
            }, 100);
            return res;
        }

        scene.blocks.forEach(col => col.forEach(b => {
            b.removeAllListeners('player_click');
            b.on('player_click', function() { scene.playerClick(this.i, this.j); });
        }));

        isHooked = true;
        setTimeout(() => drawPrediction(scene), 500);
    }

    btnUndo.onclick = undo;
    setInterval(hook, 1000);

})();
