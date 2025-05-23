#!/bin/bash

# 弓箭手大作战部署脚本
# 服务器: 103.40.14.219:52855

echo "开始部署弓箭手大作战到远程服务器..."

# 服务器信息
SERVER_IP="103.40.14.219"
SERVER_PORT="52855"
SERVER_USER="root"
PROJECT_NAME="archer-battle-io"
DEPLOY_PATH="/opt/$PROJECT_NAME"

echo "1. 检查服务器环境..."

# 创建远程执行脚本
cat > remote_commands.sh << 'EOF'
#!/bin/bash

echo "检查系统环境..."
uname -a
echo "检查内存..."
free -h
echo "检查磁盘..."
df -h

echo "检查Node.js..."
if ! command -v node &> /dev/null; then
    echo "Node.js未安装，开始安装..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    apt-get install -y nodejs
else
    echo "Node.js版本: $(node --version)"
    echo "NPM版本: $(npm --version)"
fi

echo "检查pm2..."
if ! command -v pm2 &> /dev/null; then
    echo "PM2未安装，开始安装..."
    npm install -g pm2
else
    echo "PM2已安装: $(pm2 --version)"
fi

echo "创建项目目录..."
mkdir -p /opt/archer-battle-io
cd /opt/archer-battle-io

echo "环境检查完成!"
EOF

echo "2. 上传并执行环境检查脚本..."
scp -P $SERVER_PORT remote_commands.sh $SERVER_USER@$SERVER_IP:/tmp/
ssh -p $SERVER_PORT $SERVER_USER@$SERVER_IP 'chmod +x /tmp/remote_commands.sh && /tmp/remote_commands.sh'

echo "3. 上传项目文件..."
# 排除node_modules等不必要的文件
rsync -avz --progress \
    --exclude 'node_modules' \
    --exclude '.git' \
    --exclude '*.log' \
    --exclude 'deploy.sh' \
    --exclude 'remote_commands.sh' \
    -e "ssh -p $SERVER_PORT" \
    ./ $SERVER_USER@$SERVER_IP:$DEPLOY_PATH/

echo "4. 在服务器上安装依赖并启动服务..."
ssh -p $SERVER_PORT $SERVER_USER@$SERVER_IP << EOF
cd $DEPLOY_PATH
echo "当前目录: \$(pwd)"
echo "项目文件:"
ls -la

echo "安装依赖..."
npm install --production

echo "停止现有服务..."
pm2 stop $PROJECT_NAME 2>/dev/null || true
pm2 delete $PROJECT_NAME 2>/dev/null || true

echo "启动服务..."
pm2 start server.js --name $PROJECT_NAME

echo "设置开机自启..."
pm2 startup
pm2 save

echo "检查服务状态..."
pm2 list
pm2 logs $PROJECT_NAME --lines 10

echo "检查端口..."
netstat -tlnp | grep :3000 || echo "端口3000未监听"

echo "部署完成!"
echo "游戏地址: http://$SERVER_IP:3000"
EOF

echo "清理临时文件..."
rm -f remote_commands.sh

echo "部署完成!"
echo "你的弓箭手大作战游戏已部署到: http://$SERVER_IP:3000"
echo "可以使用以下命令管理服务:"
echo "  查看状态: ssh -p $SERVER_PORT $SERVER_USER@$SERVER_IP 'pm2 list'"
echo "  查看日志: ssh -p $SERVER_PORT $SERVER_USER@$SERVER_IP 'pm2 logs $PROJECT_NAME'"
echo "  重启服务: ssh -p $SERVER_PORT $SERVER_USER@$SERVER_IP 'pm2 restart $PROJECT_NAME'" 