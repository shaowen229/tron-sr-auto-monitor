const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cron = require('node-cron');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ==================== 数据库初始化 ====================
// 连接SQLite数据库，不存在则自动创建
const db = new sqlite3.Database(path.join(__dirname, 'block.db'), (err) => {
  if (err) console.error('数据库连接失败:', err.message);
  else console.log('数据库连接成功');
});

// 创建区块表（存储所有抓到的区块，含北京时间）
db.run(`CREATE TABLE IF NOT EXISTS blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  block_height INTEGER UNIQUE NOT NULL,
  block_hash TEXT NOT NULL,
  miner_address TEXT NOT NULL,
  block_time_utc INTEGER NOT NULL,
  block_time_beijing TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);

// ==================== 北京时间转换工具 ====================
// 波场时间戳是毫秒级UTC时间，转换为北京时间（UTC+8）
function utcToBeijing(timestampMs) {
  const date = new Date(timestampMs);
  // 加8小时转为北京时间
  const beijingDate = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  // 格式：YYYY-MM-DD HH:mm:ss
  return beijingDate.toISOString().replace('T', ' ').substring(0, 19);
}

// ==================== 抓最新区块并存储 ====================
async function fetchAndSaveLatestBlock() {
  try {
    // 1. 从波场TronGrid API抓最新区块（官方API，稳定可靠）
    const { data } = await axios.get('https://api.trongrid.io/wallet/getnowblock');
    const blockHeight = data.block_header.raw_data.number;
    const blockHash = data.blockID;
    const minerAddress = data.block_header.raw_data.witness_address;
    const blockTimeUtcMs = data.block_header.raw_data.timestamp; // 波场时间戳：毫秒级UTC

    // 2. 转换为北京时间
    const blockTimeBeijing = utcToBeijing(blockTimeUtcMs);

    // 3. 检查区块是否已存在（避免重复存储）
    db.get('SELECT * FROM blocks WHERE block_height = ?', [blockHeight], (err, row) => {
      if (err) {
        console.error('查询区块失败:', err.message);
        return;
      }
      // 区块不存在，插入数据库
      if (!row) {
        db.run(`INSERT INTO blocks (block_height, block_hash, miner_address, block_time_utc, block_time_beijing)
                VALUES (?, ?, ?, ?, ?)`,
          [blockHeight, blockHash, minerAddress, blockTimeUtcMs, blockTimeBeijing],
          (insertErr) => {
            if (insertErr) {
              console.error('插入区块失败:', insertErr.message);
            } else {
              console.log(`✅ 新块已存储：高度${blockHeight}，北京时间${blockTimeBeijing}`);
            }
          }
        );
      }
    });
  } catch (err) {
    console.error('抓区块失败:', err.message);
  }
}

// ==================== 定时任务：每10秒抓一次最新区块 ====================
// cron表达式：*/10 * * * * * 表示每10秒执行一次（可调整频率，比如*/30 * * * * * 每30秒）
cron.schedule('*/10 * * * * *', fetchAndSaveLatestBlock, {
  scheduled: true,
  timezone: 'Asia/Shanghai' // 时区设为上海，确保定时任务北京时间准确
});

// ==================== API接口（给前端用） ====================
// 1. 获取最新区块
app.get('/api/latest-block', (req, res) => {
  db.get('SELECT * FROM blocks ORDER BY block_height DESC LIMIT 1', (err, row) => {
    if (err) {
      res.status(500).json({ error: '获取最新块失败', details: err.message });
      return;
    }
    res.json(row || { message: '暂无区块数据' });
  });
});

// 2. 获取历史区块记录（分页，最新在前）
app.get('/api/blocks', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const pageSize = parseInt(req.query.pageSize) || 20;
  const offset = (page - 1) * pageSize;

  db.all('SELECT * FROM blocks ORDER BY block_height DESC LIMIT ? OFFSET ?', [pageSize, offset], (err, rows) => {
    if (err) {
      res.status(500).json({ error: '获取历史块失败', details: err.message });
      return;
    }
    res.json(rows);
  });
});

// 3. 健康检查接口
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: '波场SR自动监控服务正常运行',
    beijingTime: utcToBeijing(Date.now()),
    timestamp: new Date().toISOString()
  });
});

// ==================== 启动服务 ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 后端服务启动成功，端口：${PORT}，时区：Asia/Shanghai`);
  // 启动时立刻抓一次块，不用等定时任务
  fetchAndSaveLatestBlock();
});

// 优雅关闭数据库
process.on('SIGINT', () => {
  db.close((err) => {
    if (err) console.error('数据库关闭失败:', err.message);
    else console.log('数据库关闭成功');
    process.exit(0);
  });
}); 
