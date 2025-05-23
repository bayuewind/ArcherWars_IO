// 游戏客户端
class ArcherBattleGame {
    constructor() {
        this.socket = io();
        this.canvas = document.getElementById('gameCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.minimap = document.getElementById('minimap');
        this.minimapCtx = this.minimap.getContext('2d');
        
        // 游戏状态
        this.playerId = null;
        this.players = {};
        this.arrows = [];
        this.expBeans = [];
        this.obstacles = [];
        this.gameConfig = {};
        this.currentPlayer = null;
        
        // 相机
        this.camera = { x: 0, y: 0 };
        
        // 输入状态
        this.keys = {};
        this.mouse = { x: 0, y: 0, worldX: 0, worldY: 0 };
        this.isMouseDown = false;
        
        // 游戏循环
        this.lastTime = 0;
        this.gameRunning = false;
        
        // 网络优化
        this.lastMoveSent = 0;
        this.lastPlayerState = null;
        this.moveSendInterval = 50; // 50ms发送一次移动数据 (20FPS)
        
        // 添加Socket.IO连接调试
        this.socket.on('connect', () => {
            console.log('Socket.IO 连接成功:', this.socket.id);
        });
        
        this.socket.on('disconnect', () => {
            console.log('Socket.IO 连接断开');
        });
        
        this.socket.on('connect_error', (error) => {
            console.error('Socket.IO 连接错误:', error);
        });
        
        this.initializeEvents();
    }
    
    initializeEvents() {
        // Socket事件
        this.socket.on('gameJoined', (data) => {
            console.log('收到 gameJoined 事件:', data);
            this.playerId = data.playerId;
            this.obstacles = data.obstacles;
            this.gameConfig = data.config;
            console.log('开始游戏，玩家ID:', this.playerId);
            this.startGame();
        });
        
        this.socket.on('gameState', (state) => {
            // 添加调试信息
            console.log('接收到游戏状态:', state);
            
            // 检查数据格式
            if (!state) {
                console.error('游戏状态数据为空:', state);
                return;
            }
            
            // 直接使用原始数据，而不是压缩数据
            if (state.players) {
                this.players = state.players;
                this.arrows = state.arrows || [];
                this.expBeans = state.expBeans || [];
            } else if (state.p) {
                // 如果收到压缩数据，解压缩
                this.players = this.decompressPlayers(state.p);
                this.arrows = this.decompressArrows(state.a || []);
                this.expBeans = state.e || [];
            }
            
            this.currentPlayer = this.players[this.playerId];
            
            // 添加调试信息
            console.log('当前玩家:', this.currentPlayer);
            console.log('玩家数量:', Object.keys(this.players).length);
            
            this.updateUI();
        });
        
        this.socket.on('upgradeOptions', (options) => {
            this.showUpgradeModal(options);
        });
        
        this.socket.on('upgradeComplete', (data) => {
            this.hideUpgradeModal();
            this.showNotification(`升级完成: ${data.upgrade} (等级 ${data.level})`);
        });
        
        // 键盘事件
        document.addEventListener('keydown', (e) => {
            this.keys[e.code] = true;
            
            if (e.code === 'KeyF') {
                this.collectNearbyExp();
            }
        });
        
        document.addEventListener('keyup', (e) => {
            this.keys[e.code] = false;
        });
        
        // 鼠标事件
        this.canvas.addEventListener('mousemove', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            this.mouse.x = e.clientX - rect.left;
            this.mouse.y = e.clientY - rect.top;
            this.updateMouseWorldPosition();
        });
        
        this.canvas.addEventListener('mousedown', (e) => {
            if (e.button === 0) { // 左键
                this.isMouseDown = true;
                this.shoot();
            }
        });
        
        this.canvas.addEventListener('mouseup', (e) => {
            if (e.button === 0) {
                this.isMouseDown = false;
            }
        });
        
        // 阻止右键菜单
        this.canvas.addEventListener('contextmenu', (e) => {
            e.preventDefault();
        });
    }
    
    updateMouseWorldPosition() {
        if (this.currentPlayer) {
            this.mouse.worldX = this.mouse.x + this.camera.x - this.canvas.width / 2;
            this.mouse.worldY = this.mouse.y + this.camera.y - this.canvas.height / 2;
        }
    }
    
    startGame() {
        document.getElementById('loginScreen').style.display = 'none';
        document.getElementById('gameUI').style.display = 'block';
        this.gameRunning = true;
        this.gameLoop();
    }
    
    gameLoop(currentTime = 0) {
        if (!this.gameRunning) return;
        
        const deltaTime = currentTime - this.lastTime;
        this.lastTime = currentTime;
        
        this.update(deltaTime);
        this.render();
        
        requestAnimationFrame((time) => this.gameLoop(time));
    }
    
    update(deltaTime) {
        if (!this.currentPlayer) return;
        
        // 更新玩家位置
        this.updatePlayerMovement();
        
        // 更新相机
        this.updateCamera();
        
        // 更新鼠标世界坐标
        this.updateMouseWorldPosition();
        
        // 持续射击
        if (this.isMouseDown) {
            this.shoot();
        }
    }
    
    updatePlayerMovement() {
        const player = this.currentPlayer;
        if (!player) return;
        
        let moveX = 0;
        let moveY = 0;
        
        if (this.keys['KeyW'] || this.keys['ArrowUp']) moveY -= 1;
        if (this.keys['KeyS'] || this.keys['ArrowDown']) moveY += 1;
        if (this.keys['KeyA'] || this.keys['ArrowLeft']) moveX -= 1;
        if (this.keys['KeyD'] || this.keys['ArrowRight']) moveX += 1;
        
        // 归一化移动向量
        if (moveX !== 0 || moveY !== 0) {
            const length = Math.sqrt(moveX * moveX + moveY * moveY);
            moveX = (moveX / length) * player.speed;
            moveY = (moveY / length) * player.speed;
        }
        
        const newX = player.x + moveX;
        const newY = player.y + moveY;
        
        // 计算瞄准角度
        const angle = Math.atan2(this.mouse.worldY - player.y, this.mouse.worldX - player.x);
        
        // 网络优化：只在必要时发送移动数据
        const now = Date.now();
        const shouldSendMove = now - this.lastMoveSent > this.moveSendInterval;
        
        // 检查是否有实际移动或角度变化
        const hasMovement = moveX !== 0 || moveY !== 0;
        const hasAngleChange = !this.lastPlayerState || 
            Math.abs(angle - this.lastPlayerState.angle) > 0.1;
        const hasPositionChange = !this.lastPlayerState ||
            Math.abs(newX - this.lastPlayerState.x) > 1 ||
            Math.abs(newY - this.lastPlayerState.y) > 1;
        
        if (shouldSendMove && (hasMovement || hasAngleChange || hasPositionChange)) {
            this.socket.emit('playerMove', {
                x: newX,
                y: newY,
                angle: angle
            });
            
            this.lastMoveSent = now;
            this.lastPlayerState = { x: newX, y: newY, angle: angle };
        }
    }
    
    updateCamera() {
        if (this.currentPlayer) {
            this.camera.x = this.currentPlayer.x;
            this.camera.y = this.currentPlayer.y;
        }
    }
    
    shoot() {
        this.socket.emit('shoot');
    }
    
    collectNearbyExp() {
        if (!this.currentPlayer) return;
        
        for (let bean of this.expBeans) {
            const distance = Math.sqrt(
                Math.pow(bean.x - this.currentPlayer.x, 2) + 
                Math.pow(bean.y - this.currentPlayer.y, 2)
            );
            
            if (distance < 30) {
                this.socket.emit('collectExp', bean.id);
            }
        }
    }
    
    render() {
        // 清空画布
        this.ctx.fillStyle = '#0a0a0a';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        
        // 保存状态
        this.ctx.save();
        
        // 应用相机变换
        this.ctx.translate(
            this.canvas.width / 2 - this.camera.x,
            this.canvas.height / 2 - this.camera.y
        );
        
        // 绘制网格背景
        this.drawGrid();
        
        // 绘制障碍物
        this.drawObstacles();
        
        // 绘制经验豆
        this.drawExpBeans();
        
        // 绘制玩家
        this.drawPlayers();
        
        // 绘制箭矢
        this.drawArrows();
        
        // 恢复状态
        this.ctx.restore();
        
        // 绘制小地图
        this.drawMinimap();
        
        // 更新排行榜
        this.updateLeaderboard();
    }
    
    drawGrid() {
        this.ctx.strokeStyle = '#111';
        this.ctx.lineWidth = 1;
        
        const gridSize = 50;
        const startX = Math.floor(this.camera.x / gridSize) * gridSize;
        const startY = Math.floor(this.camera.y / gridSize) * gridSize;
        
        for (let x = startX - 500; x < startX + this.canvas.width + 500; x += gridSize) {
            this.ctx.beginPath();
            this.ctx.moveTo(x, this.camera.y - 500);
            this.ctx.lineTo(x, this.camera.y + this.canvas.height + 500);
            this.ctx.stroke();
        }
        
        for (let y = startY - 500; y < startY + this.canvas.height + 500; y += gridSize) {
            this.ctx.beginPath();
            this.ctx.moveTo(this.camera.x - 500, y);
            this.ctx.lineTo(this.camera.x + this.canvas.width + 500, y);
            this.ctx.stroke();
        }
    }
    
    drawObstacles() {
        this.ctx.fillStyle = '#444';
        this.ctx.strokeStyle = '#666';
        this.ctx.lineWidth = 2;
        
        for (let obstacle of this.obstacles) {
            this.ctx.fillRect(obstacle.x, obstacle.y, obstacle.width, obstacle.height);
            this.ctx.strokeRect(obstacle.x, obstacle.y, obstacle.width, obstacle.height);
        }
    }
    
    drawExpBeans() {
        for (let bean of this.expBeans) {
            // 经验豆发光效果
            const gradient = this.ctx.createRadialGradient(bean.x, bean.y, 0, bean.x, bean.y, 15);
            gradient.addColorStop(0, '#ffc107');
            gradient.addColorStop(0.7, '#ff9800');
            gradient.addColorStop(1, 'transparent');
            
            this.ctx.fillStyle = gradient;
            this.ctx.beginPath();
            this.ctx.arc(bean.x, bean.y, 15, 0, Math.PI * 2);
            this.ctx.fill();
            
            // 内核
            this.ctx.fillStyle = '#ffc107';
            this.ctx.beginPath();
            this.ctx.arc(bean.x, bean.y, 6, 0, Math.PI * 2);
            this.ctx.fill();
        }
    }
    
    drawPlayers() {
        for (let playerId in this.players) {
            const player = this.players[playerId];
            this.drawPlayer(player, playerId === this.playerId);
        }
    }
    
    drawPlayer(player, isCurrentPlayer) {
        // 玩家主体
        this.ctx.fillStyle = isCurrentPlayer ? '#4fc3f7' : '#ff4444';
        this.ctx.strokeStyle = '#fff';
        this.ctx.lineWidth = 2;
        
        this.ctx.save();
        this.ctx.translate(player.x, player.y);
        this.ctx.rotate(player.angle);
        
        // 身体
        this.ctx.fillRect(-10, -8, 20, 16);
        this.ctx.strokeRect(-10, -8, 20, 16);
        
        // 弓
        this.ctx.strokeStyle = '#8B4513';
        this.ctx.lineWidth = 3;
        this.ctx.beginPath();
        this.ctx.moveTo(15, -10);
        this.ctx.lineTo(25, 0);
        this.ctx.lineTo(15, 10);
        this.ctx.stroke();
        
        this.ctx.restore();
        
        // 血条
        this.drawHealthBar(player);
        
        // 玩家名字
        this.ctx.fillStyle = '#fff';
        this.ctx.font = '12px Arial';
        this.ctx.textAlign = 'center';
        this.ctx.fillText(player.name, player.x, player.y - 25);
        
        // 等级
        this.ctx.fillStyle = '#4fc3f7';
        this.ctx.font = 'bold 10px Arial';
        this.ctx.fillText(`Lv.${player.level}`, player.x, player.y - 35);
    }
    
    drawHealthBar(player) {
        const barWidth = 30;
        const barHeight = 4;
        const x = player.x - barWidth / 2;
        const y = player.y - 20;
        
        // 背景
        this.ctx.fillStyle = '#333';
        this.ctx.fillRect(x, y, barWidth, barHeight);
        
        // 生命值
        const healthPercent = player.hp / player.maxHp;
        this.ctx.fillStyle = healthPercent > 0.5 ? '#4caf50' : healthPercent > 0.25 ? '#ff9800' : '#f44336';
        this.ctx.fillRect(x, y, barWidth * healthPercent, barHeight);
        
        // 边框
        this.ctx.strokeStyle = '#fff';
        this.ctx.lineWidth = 1;
        this.ctx.strokeRect(x, y, barWidth, barHeight);
    }
    
    drawArrows() {
        this.ctx.fillStyle = '#fff';
        this.ctx.strokeStyle = '#ccc';
        this.ctx.lineWidth = 1;
        
        for (let arrow of this.arrows) {
            this.ctx.save();
            this.ctx.translate(arrow.x, arrow.y);
            this.ctx.rotate(arrow.angle);
            
            // 箭身
            this.ctx.fillRect(-8, -2, 16, 4);
            this.ctx.strokeRect(-8, -2, 16, 4);
            
            // 箭头
            this.ctx.beginPath();
            this.ctx.moveTo(8, -4);
            this.ctx.lineTo(12, 0);
            this.ctx.lineTo(8, 4);
            this.ctx.closePath();
            this.ctx.fill();
            this.ctx.stroke();
            
            this.ctx.restore();
        }
    }
    
    drawMinimap() {
        const minimapScale = 0.1;
        const minimapWidth = this.minimap.width;
        const minimapHeight = this.minimap.height;
        
        // 清空小地图
        this.minimapCtx.fillStyle = '#000';
        this.minimapCtx.fillRect(0, 0, minimapWidth, minimapHeight);
        
        if (!this.gameConfig.MAP_WIDTH) return;
        
        // 绘制边界
        this.minimapCtx.strokeStyle = '#4fc3f7';
        this.minimapCtx.lineWidth = 2;
        this.minimapCtx.strokeRect(0, 0, minimapWidth, minimapHeight);
        
        // 绘制障碍物
        this.minimapCtx.fillStyle = '#666';
        for (let obstacle of this.obstacles) {
            const x = (obstacle.x / this.gameConfig.MAP_WIDTH) * minimapWidth;
            const y = (obstacle.y / this.gameConfig.MAP_HEIGHT) * minimapHeight;
            const w = (obstacle.width / this.gameConfig.MAP_WIDTH) * minimapWidth;
            const h = (obstacle.height / this.gameConfig.MAP_HEIGHT) * minimapHeight;
            this.minimapCtx.fillRect(x, y, w, h);
        }
        
        // 绘制玩家
        for (let playerId in this.players) {
            const player = this.players[playerId];
            const x = (player.x / this.gameConfig.MAP_WIDTH) * minimapWidth;
            const y = (player.y / this.gameConfig.MAP_HEIGHT) * minimapHeight;
            
            this.minimapCtx.fillStyle = playerId === this.playerId ? '#4fc3f7' : '#ff4444';
            this.minimapCtx.beginPath();
            this.minimapCtx.arc(x, y, 3, 0, Math.PI * 2);
            this.minimapCtx.fill();
        }
    }
    
    updateUI() {
        if (!this.currentPlayer) return;
        
        // 更新生命值条
        const healthPercent = this.currentPlayer.hp / this.currentPlayer.maxHp;
        document.getElementById('healthFill').style.width = `${healthPercent * 100}%`;
        
        // 更新经验值条
        const expCosts = [100, 200, 400, 800, 1600];
        const requiredExp = expCosts[Math.min(this.currentPlayer.level - 1, 4)];
        const expPercent = this.currentPlayer.exp / requiredExp;
        document.getElementById('expFill').style.width = `${Math.min(expPercent * 100, 100)}%`;
        
        // 更新其他信息
        document.getElementById('levelValue').textContent = this.currentPlayer.level;
        document.getElementById('killsValue').textContent = this.currentPlayer.kills;
        
        // 更新房间信息
        const playerCount = Object.keys(this.players).length;
        document.getElementById('roomPlayers').textContent = `${playerCount}/30`;
    }
    
    updateLeaderboard() {
        const playerList = Object.values(this.players)
            .sort((a, b) => b.kills - a.kills)
            .slice(0, 10);
        
        const leaderboardList = document.getElementById('leaderboardList');
        leaderboardList.innerHTML = '';
        
        playerList.forEach((player, index) => {
            const item = document.createElement('div');
            item.className = 'leader-item';
            item.innerHTML = `
                <span class="leader-name">${index + 1}. ${player.name}</span>
                <span>${player.kills}</span>
            `;
            leaderboardList.appendChild(item);
        });
    }
    
    showUpgradeModal(options) {
        const modal = document.getElementById('upgradeModal');
        const optionsContainer = document.getElementById('upgradeOptions');
        
        optionsContainer.innerHTML = '';
        
        options.forEach(option => {
            const div = document.createElement('div');
            div.className = 'upgrade-option';
            div.innerHTML = `<strong>${option.name}</strong>`;
            div.onclick = () => {
                this.socket.emit('selectUpgrade', option.key);
            };
            optionsContainer.appendChild(div);
        });
        
        modal.style.display = 'block';
    }
    
    hideUpgradeModal() {
        document.getElementById('upgradeModal').style.display = 'none';
    }
    
    showNotification(message) {
        // 简单的通知系统
        const notification = document.createElement('div');
        notification.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(79, 195, 247, 0.9);
            color: white;
            padding: 20px;
            border-radius: 10px;
            font-weight: bold;
            z-index: 2000;
            animation: fadeInOut 3s ease-in-out;
        `;
        notification.textContent = message;
        document.body.appendChild(notification);
        
        setTimeout(() => {
            document.body.removeChild(notification);
        }, 3000);
    }
    
    // 解压缩玩家数据
    decompressPlayers(compressedPlayers) {
        const players = {};
        for (let playerId in compressedPlayers) {
            const p = compressedPlayers[playerId];
            players[playerId] = {
                id: playerId,
                name: p.n,
                x: p.x,
                y: p.y,
                angle: p.a,
                hp: p.h,
                maxHp: p.m,
                exp: p.e,
                level: p.l,
                kills: p.k,
                alive: p.v,
                speed: p.s || 3  // 添加速度字段，如果没有则使用默认值
            };
        }
        return players;
    }
    
    // 解压缩箭矢数据
    decompressArrows(compressedArrows) {
        return compressedArrows.map(a => ({
            id: a.i,
            x: a.x,
            y: a.y,
            angle: a.a,
            shooterId: a.s
        }));
    }
}

// 全局变量
let game;

// 加入游戏函数
function joinGame() {
    console.log('joinGame 函数被调用');
    
    const playerName = document.getElementById('playerName').value.trim();
    console.log('玩家名字:', playerName);
    
    if (playerName === '') {
        alert('请输入你的名字！');
        return;
    }
    
    if (!game) {
        console.log('创建新的游戏实例');
        game = new ArcherBattleGame();
    }
    
    console.log('Socket.IO 连接状态:', game.socket.connected);
    
    // 确保连接后再发送事件
    if (game.socket.connected) {
        console.log('Socket已连接，发送 joinGame 事件');
        game.socket.emit('joinGame', playerName);
    } else {
        console.log('Socket未连接，等待连接...');
        game.socket.on('connect', () => {
            console.log('Socket连接成功，发送 joinGame 事件');
            game.socket.emit('joinGame', playerName);
        });
    }
}

// 添加淡入淡出动画
const style = document.createElement('style');
style.textContent = `
    @keyframes fadeInOut {
        0% { opacity: 0; transform: translate(-50%, -50%) scale(0.8); }
        20% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        80% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        100% { opacity: 0; transform: translate(-50%, -50%) scale(0.8); }
    }
`;
document.head.appendChild(style);

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', () => {
    // 聚焦到输入框
    document.getElementById('playerName').focus();
    
    // 回车键加入游戏
    document.getElementById('playerName').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            joinGame();
        }
    });
}); 