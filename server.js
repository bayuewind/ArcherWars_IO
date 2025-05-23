const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// 静态文件服务
app.use(express.static(path.join(__dirname, 'public')));

// 游戏常量
const GAME_CONFIG = {
    MAP_WIDTH: 2000,
    MAP_HEIGHT: 2000,
    MAX_PLAYERS_PER_ROOM: 30,
    PLAYER_SPEED: 3,
    ARROW_SPEED: 8,
    ARROW_DAMAGE: 25,
    BASE_HP: 100,
    EXP_DROP_RATIO: 0.33,
    UPGRADE_EXP_COST: [100, 200, 400, 800, 1600]
};

// 游戏状态
let rooms = {};
let playerRooms = {}; // playerId -> roomId

// 升级选项
const UPGRADE_OPTIONS = {
    damage: { name: '伤害提升', effect: (player) => player.damage += 10 },
    speed: { name: '移动速度', effect: (player) => player.speed += 0.5 },
    health: { name: '生命值', effect: (player) => { player.maxHp += 20; player.hp += 20; }},
    piercing: { name: '穿透射击', effect: (player) => player.piercing = true },
    multishot: { name: '多重射击', effect: (player) => player.multishot = (player.multishot || 1) + 1 },
    reload: { name: '射击速度', effect: (player) => player.reloadTime = Math.max(200, player.reloadTime - 100) },
    regen: { name: '呼吸回血', effect: (player) => player.healthRegen += 0.5 },
    ricochet: { name: '箭头反弹', effect: (player) => player.ricochetCount += 1 }
};

// 生成障碍物
function generateObstacles(roomId) {
    const obstacles = [];
    const numObstacles = 15;
    
    for (let i = 0; i < numObstacles; i++) {
        obstacles.push({
            x: Math.random() * (GAME_CONFIG.MAP_WIDTH - 100) + 50,
            y: Math.random() * (GAME_CONFIG.MAP_HEIGHT - 100) + 50,
            width: 50 + Math.random() * 100,
            height: 50 + Math.random() * 100
        });
    }
    
    return obstacles;
}

// 生成经验豆
function generateExpBeans(roomId) {
    const beans = [];
    const numBeans = 100;
    
    for (let i = 0; i < numBeans; i++) {
        beans.push({
            id: uuidv4(),
            x: Math.random() * GAME_CONFIG.MAP_WIDTH,
            y: Math.random() * GAME_CONFIG.MAP_HEIGHT,
            value: 10 + Math.random() * 20
        });
    }
    
    return beans;
}

// 创建新房间
function createRoom() {
    const roomId = uuidv4();
    rooms[roomId] = {
        id: roomId,
        players: {},
        arrows: [],
        obstacles: generateObstacles(roomId),
        expBeans: generateExpBeans(roomId),
        playerCount: 0
    };
    return roomId;
}

// 查找可用房间或创建新房间
function findAvailableRoom() {
    for (let roomId in rooms) {
        if (rooms[roomId].playerCount < GAME_CONFIG.MAX_PLAYERS_PER_ROOM) {
            return roomId;
        }
    }
    return createRoom();
}

// 创建新玩家
function createPlayer(socketId, name, roomId) {
    // 先创建基础玩家对象
    const player = {
        id: socketId,
        name: name || `玩家${Math.floor(Math.random() * 1000)}`,
        x: 0, // 将在外部设置
        y: 0, // 将在外部设置
        angle: 0,
        hp: GAME_CONFIG.BASE_HP,
        maxHp: GAME_CONFIG.BASE_HP,
        exp: 0,
        level: 1,
        damage: GAME_CONFIG.ARROW_DAMAGE,
        speed: GAME_CONFIG.PLAYER_SPEED,
        reloadTime: 500,
        lastShot: 0,
        piercing: false,
        multishot: 1,
        healthRegen: 0,      // 初始回血速度为0/s
        ricochetCount: 0,    // 初始反弹次数为0次
        kills: 0,
        alive: true
    };
    
    return player;
}

// 碰撞检测
function checkCollision(obj1, obj2, size1 = 20, size2 = 20) {
    return Math.abs(obj1.x - obj2.x) < size1 && Math.abs(obj1.y - obj2.y) < size2;
}

// 检查与障碍物碰撞
function checkObstacleCollision(x, y, obstacles) {
    for (let obstacle of obstacles) {
        if (x > obstacle.x && x < obstacle.x + obstacle.width &&
            y > obstacle.y && y < obstacle.y + obstacle.height) {
            return true;
        }
    }
    return false;
}

// 寻找安全的重生位置
function findSafeRespawnPosition(roomId, excludePlayerId = null) {
    const room = rooms[roomId];
    const maxAttempts = 50; // 最大尝试次数
    
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const x = 50 + Math.random() * (GAME_CONFIG.MAP_WIDTH - 100);
        const y = 50 + Math.random() * (GAME_CONFIG.MAP_HEIGHT - 100);
        
        // 检查是否与障碍物碰撞
        if (checkObstacleCollision(x, y, room.obstacles)) {
            continue;
        }
        
        // 检查是否距离其他玩家太近
        let tooClose = false;
        for (let playerId in room.players) {
            // 跳过要排除的玩家（通常是正在重生的玩家）
            if (playerId === excludePlayerId) {
                continue;
            }
            
            const otherPlayer = room.players[playerId];
            if (otherPlayer.alive) {
                const distance = Math.sqrt(
                    Math.pow(x - otherPlayer.x, 2) + 
                    Math.pow(y - otherPlayer.y, 2)
                );
                if (distance < 100) { // 最小距离100像素
                    tooClose = true;
                    break;
                }
            }
        }
        
        if (!tooClose) {
            return { x, y };
        }
    }
    
    // 如果找不到安全位置，使用边缘的默认位置
    const corners = [
        { x: 100, y: 100 },
        { x: GAME_CONFIG.MAP_WIDTH - 100, y: 100 },
        { x: 100, y: GAME_CONFIG.MAP_HEIGHT - 100 },
        { x: GAME_CONFIG.MAP_WIDTH - 100, y: GAME_CONFIG.MAP_HEIGHT - 100 }
    ];
    
    return corners[Math.floor(Math.random() * corners.length)];
}

// 处理玩家死亡
function handlePlayerDeath(playerId, killerId, roomId) {
    const room = rooms[roomId];
    const player = room.players[playerId];
    const killer = room.players[killerId];
    
    if (!player || !killer) return;
    
    // 掉落经验豆
    const expToDrop = Math.floor(player.exp * GAME_CONFIG.EXP_DROP_RATIO);
    const numBeans = Math.min(20, Math.max(5, Math.floor(expToDrop / 10)));
    
    for (let i = 0; i < numBeans; i++) {
        room.expBeans.push({
            id: uuidv4(),
            x: player.x + (Math.random() - 0.5) * 100,
            y: player.y + (Math.random() - 0.5) * 100,
            value: Math.floor(expToDrop / numBeans)
        });
    }
    
    // 杀手获得经验
    killer.exp += expToDrop;
    killer.kills++;
    
    // 重置被杀玩家 - 完全重置到初始状态
    player.level = 1;                                    // 等级重置为1
    player.hp = GAME_CONFIG.BASE_HP;                     // 生命值重置
    player.maxHp = GAME_CONFIG.BASE_HP;                  // 最大生命值重置
    player.exp = 0;                                      // 经验值清零
    player.damage = GAME_CONFIG.ARROW_DAMAGE;            // 伤害重置
    player.speed = GAME_CONFIG.PLAYER_SPEED;             // 速度重置
    player.reloadTime = 500;                             // 射击速度重置
    player.piercing = false;                             // 穿透效果重置
    player.multishot = 1;                                // 多重射击重置
    player.healthRegen = 0;                              // 回血速度重置
    player.ricochetCount = 0;                            // 反弹次数重置
    const respawnPosition = findSafeRespawnPosition(roomId, playerId);
    player.x = respawnPosition.x;
    player.y = respawnPosition.y;
    player.alive = true;
}

// 游戏主循环
function gameLoop() {
    for (let roomId in rooms) {
        const room = rooms[roomId];
        
        // 更新玩家回血
        for (let playerId in room.players) {
            const player = room.players[playerId];
            if (player.alive && player.healthRegen > 0) {
                player.hp = Math.min(player.maxHp, player.hp + player.healthRegen / 60); // 60 FPS
            }
        }
        
        // 更新箭矢
        room.arrows = room.arrows.filter(arrow => {
            // 如果箭矢没有射程计数器，添加一个
            if (!arrow.range) {
                arrow.range = 0;
            }
            // 如果箭矢没有已反弹次数计数器，添加一个
            if (!arrow.bounceCount) {
                arrow.bounceCount = 0;
            }
            
            const oldX = arrow.x;
            const oldY = arrow.y;
            
            arrow.x += Math.cos(arrow.angle) * GAME_CONFIG.ARROW_SPEED;
            arrow.y += Math.sin(arrow.angle) * GAME_CONFIG.ARROW_SPEED;
            arrow.range += GAME_CONFIG.ARROW_SPEED;
            
            // 检查边界和反弹
            let bounced = false;
            if (arrow.ricochetCount > arrow.bounceCount && arrow.range < 500) { // 还有反弹次数且射程未超限
                if (arrow.x < 0 || arrow.x > GAME_CONFIG.MAP_WIDTH) {
                    arrow.angle = Math.PI - arrow.angle; // 水平反弹
                    arrow.x = Math.max(0, Math.min(GAME_CONFIG.MAP_WIDTH, arrow.x));
                    arrow.range = 0; // 重置射程
                    arrow.bounceCount++; // 增加反弹次数
                    bounced = true;
                }
                if (arrow.y < 0 || arrow.y > GAME_CONFIG.MAP_HEIGHT) {
                    arrow.angle = -arrow.angle; // 垂直反弹
                    arrow.y = Math.max(0, Math.min(GAME_CONFIG.MAP_HEIGHT, arrow.y));
                    arrow.range = 0; // 重置射程
                    arrow.bounceCount++; // 增加反弹次数
                    bounced = true;
                }
            } else {
                // 普通箭矢超出边界就消失
                if (arrow.x < 0 || arrow.x > GAME_CONFIG.MAP_WIDTH || 
                    arrow.y < 0 || arrow.y > GAME_CONFIG.MAP_HEIGHT) {
                    return false;
                }
            }
            
            // 检查障碍物碰撞和反弹
            if (checkObstacleCollision(arrow.x, arrow.y, room.obstacles)) {
                if (arrow.ricochetCount > arrow.bounceCount) {
                    // 计算反弹角度
                    // 简化处理：随机反弹方向
                    arrow.angle += (Math.random() - 0.5) * Math.PI;
                    arrow.x = oldX;
                    arrow.y = oldY;
                    arrow.range = 0; // 重置射程
                    arrow.bounceCount++; // 增加反弹次数
                    bounced = true;
                } else {
                    return false;
                }
            }
            
            // 反弹箭矢超过最大射程也会消失
            if (arrow.ricochetCount > 0 && arrow.range > 500) {
                return false;
            }
            
            // 检查玩家碰撞
            for (let playerId in room.players) {
                const player = room.players[playerId];
                if (player.id !== arrow.shooterId && player.alive && 
                    checkCollision(arrow, player, 10, 20)) {
                    
                    player.hp -= arrow.damage;
                    
                    if (player.hp <= 0) {
                        handlePlayerDeath(playerId, arrow.shooterId, roomId);
                    }
                    
                    if (!arrow.piercing) {
                        return false;
                    }
                }
            }
            
            return true;
        });
        
        // 发送游戏状态
        io.to(roomId).emit('gameState', {
            players: room.players,
            arrows: room.arrows,
            expBeans: room.expBeans
        });
    }
}

// Socket连接处理
io.on('connection', (socket) => {
    console.log('玩家连接:', socket.id);
    
    socket.on('joinGame', (playerName) => {
        const roomId = findAvailableRoom();
        const player = createPlayer(socket.id, playerName, roomId);
        
        // 先将玩家添加到房间
        rooms[roomId].players[socket.id] = player;
        rooms[roomId].playerCount++;
        playerRooms[socket.id] = roomId;
        
        // 现在为玩家设置安全的初始位置
        const spawnPosition = findSafeRespawnPosition(roomId);
        player.x = spawnPosition.x;
        player.y = spawnPosition.y;
        
        socket.join(roomId);
        
        // 发送初始游戏数据
        socket.emit('gameJoined', {
            playerId: socket.id,
            roomId: roomId,
            obstacles: rooms[roomId].obstacles,
            config: GAME_CONFIG
        });
        
        console.log(`玩家 ${playerName} 加入房间 ${roomId}`);
    });
    
    socket.on('playerMove', (data) => {
        const roomId = playerRooms[socket.id];
        if (!roomId || !rooms[roomId] || !rooms[roomId].players[socket.id]) return;
        
        const player = rooms[roomId].players[socket.id];
        const newX = Math.max(20, Math.min(GAME_CONFIG.MAP_WIDTH - 20, data.x));
        const newY = Math.max(20, Math.min(GAME_CONFIG.MAP_HEIGHT - 20, data.y));
        
        if (!checkObstacleCollision(newX, newY, rooms[roomId].obstacles)) {
            player.x = newX;
            player.y = newY;
        }
        
        player.angle = data.angle;
    });
    
    socket.on('shoot', () => {
        const roomId = playerRooms[socket.id];
        if (!roomId || !rooms[roomId] || !rooms[roomId].players[socket.id]) return;
        
        const player = rooms[roomId].players[socket.id];
        const now = Date.now();
        
        if (now - player.lastShot < player.reloadTime) return;
        
        player.lastShot = now;
        
        const shots = player.multishot || 1;
        for (let i = 0; i < shots; i++) {
            const angleOffset = shots > 1 ? (i - (shots - 1) / 2) * 0.2 : 0;
            rooms[roomId].arrows.push({
                id: uuidv4(),
                x: player.x,
                y: player.y,
                angle: player.angle + angleOffset,
                damage: player.damage,
                shooterId: socket.id,
                piercing: player.piercing,
                ricochetCount: player.ricochetCount,
                bounceCount: 0,
                range: 0
            });
        }
    });
    
    socket.on('collectExp', (beanId) => {
        const roomId = playerRooms[socket.id];
        if (!roomId || !rooms[roomId] || !rooms[roomId].players[socket.id]) return;
        
        const room = rooms[roomId];
        const player = room.players[socket.id];
        const beanIndex = room.expBeans.findIndex(bean => bean.id === beanId);
        
        if (beanIndex !== -1) {
            const bean = room.expBeans[beanIndex];
            if (checkCollision(player, bean, 20, 10)) {
                player.exp += bean.value;
                room.expBeans.splice(beanIndex, 1);
                
                // 检查是否可以升级
                const requiredExp = GAME_CONFIG.UPGRADE_EXP_COST[Math.min(player.level - 1, 4)];
                if (player.exp >= requiredExp) {
                    const options = Object.keys(UPGRADE_OPTIONS)
                        .sort(() => Math.random() - 0.5)
                        .slice(0, 3)
                        .map(key => ({ key, ...UPGRADE_OPTIONS[key] }));
                    
                    socket.emit('upgradeOptions', options);
                }
            }
        }
    });
    
    socket.on('selectUpgrade', (upgradeKey) => {
        const roomId = playerRooms[socket.id];
        if (!roomId || !rooms[roomId] || !rooms[roomId].players[socket.id]) return;
        
        const player = rooms[roomId].players[socket.id];
        const upgrade = UPGRADE_OPTIONS[upgradeKey];
        
        if (upgrade) {
            const requiredExp = GAME_CONFIG.UPGRADE_EXP_COST[Math.min(player.level - 1, 4)];
            if (player.exp >= requiredExp) {
                player.exp -= requiredExp;
                player.level++;
                upgrade.effect(player);
                
                socket.emit('upgradeComplete', {
                    upgrade: upgrade.name,
                    level: player.level
                });
            }
        }
    });
    
    socket.on('disconnect', () => {
        const roomId = playerRooms[socket.id];
        if (roomId && rooms[roomId]) {
            delete rooms[roomId].players[socket.id];
            rooms[roomId].playerCount--;
            
            // 如果房间空了，删除房间
            if (rooms[roomId].playerCount === 0) {
                delete rooms[roomId];
            }
        }
        delete playerRooms[socket.id];
        console.log('玩家断开连接:', socket.id);
    });
});

// 启动游戏循环
setInterval(gameLoop, 1000 / 60); // 60 FPS

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`弓箭手大作战服务器运行在端口 ${PORT}`);
}); 