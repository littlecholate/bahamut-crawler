/**
 * 巴哈姆特 (Gamer.com.tw) 綜合爬蟲 V11 (Git 自動推送版)
 * 包含：首頁頭條、熱門/冷門看板最新文章
 * 特性：
 * 1. 使用 dotenv 讀取環境變數配置
 * 2. 輸出 Markdown 表格
 * 3. 過濾：置頂、非近三日、以及標題含 ['集中', '新手', '梗圖'] 的文章
 * 4. [NEW] 執行結束後自動 Commit 並 Push 到 GitHub
 */

require('dotenv').config(); // 載入 .env 檔案
const puppeteer = require('puppeteer');
const fs = require('fs');
const { exec } = require('child_process'); // 引入執行系統指令的模組

// --- 設定區 (改為從 process.env 讀取) ---

const parseArray = (envVar) => {
    if (!envVar) return [];
    return envVar
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
};

const HOT_BOARDS = parseArray(process.env.HOT_BOARDS);
const HOT_LIMIT = parseInt(process.env.HOT_LIMIT) || 20;

const COLD_BOARDS = parseArray(process.env.COLD_BOARDS);
const COLD_LIMIT = parseInt(process.env.COLD_LIMIT) || 10;

const BASE_URL = process.env.BASE_URL || 'https://www.gamer.com.tw/';
const FORUM_BASE_URL = process.env.FORUM_BASE_URL || 'https://forum.gamer.com.tw/';

// --- Git 指令輔助函式 ---
const runGitCommand = (command) => {
    return new Promise((resolve, reject) => {
        exec(command, (error, stdout, stderr) => {
            if (error) {
                // 如果是 "nothing to commit" 這種錯誤，通常可以忽略
                if (stdout.includes('nothing to commit') || stderr.includes('nothing to commit')) {
                    console.log('   ⚠️  沒有變更需要提交');
                    resolve('No changes');
                } else {
                    console.warn(`   ⚠️  Git Warning: ${stderr}`);
                    resolve(stderr); // 即使有警告也繼續執行，不中斷爬蟲流程
                }
            } else {
                resolve(stdout.trim());
            }
        });
    });
};

(async () => {
    console.log('🚀 啟動爬蟲 (Git 自動推送版)...');
    console.log(`📋 設定確認:`);
    console.log(`   - 熱門看板 ID: ${HOT_BOARDS.join(', ')} (Limit: ${HOT_LIMIT})`);
    console.log(`   - 冷門看板 ID: ${COLD_BOARDS.join(', ')} (Limit: ${COLD_LIMIT})`);

    let markdownContent = `# 巴哈姆特爬蟲日報\n\n📅 生成時間: ${new Date().toLocaleString()}\n\n`;

    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
        const page = await browser.newPage();
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
        );

        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // --- 任務 A: 爬取首頁 ---
        console.log(`\n============== 🏠 正在爬取首頁 ==============`);
        markdownContent += `## 🏠 首頁頭條\n`;

        try {
            await page.goto(BASE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
            await page.waitForSelector('.headline-news__wrapper', { timeout: 5000 });

            const homeData = await page.evaluate(() => {
                const headlines = [];
                document.querySelectorAll('.headline-news__wrapper .swiper-slide').forEach((item) => {
                    const titleEl = item.querySelector('.headline-news__title');
                    const linkEl = item.querySelector('a.headline-news__content');

                    if (titleEl && linkEl) {
                        headlines.push({
                            title: titleEl.innerText.trim(),
                            url: linkEl.href,
                        });
                    }
                });
                return headlines;
            });

            console.log(`✅ 首頁頭條 (${homeData.length} 則)`);
            homeData.forEach((news, i) => {
                console.log(`   ${i + 1}. ${news.title}`);
                markdownContent += `- [${news.title}](${news.url})\n`;
            });
            markdownContent += `\n`;
        } catch (e) {
            console.log('⚠️ 首頁載入或抓取失敗');
            markdownContent += `*(抓取失敗)*\n\n`;
        }

        // --- 定義爬取單一看板的函式 ---
        const scrapeBoard = async (boardId, limit, typeName) => {
            const targetUrl = `${FORUM_BASE_URL}B.php?bsn=${boardId}`;
            console.log(`\n🔍 [${typeName}] 前往看板 ID: ${boardId} ...`);

            await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

            try {
                await page.waitForSelector('.b-list__row', { timeout: 5000 });
            } catch (e) {
                console.log(`   ⚠️  看板 ${boardId} 載入失敗`);
                return { name: `看板 ID ${boardId}`, posts: [] };
            }

            const boardName = await page.evaluate(() => {
                const nameEl = document.querySelector('a[data-gtm="選單-看板名稱"]');
                return nameEl ? nameEl.innerText.trim() : null;
            });
            const finalName = boardName || `看板 ${boardId}`;
            console.log(`   🏷️  看板名稱: ${finalName}`);

            const allPosts = await page.evaluate(() => {
                const rows = document.querySelectorAll('tr.b-list__row');
                const results = [];
                const validTimeKeywords = ['剛剛', '分前', '小時前', '昨天'];
                const excludeKeywords = ['集中', '新手', '梗圖'];

                rows.forEach((row) => {
                    if (row.classList.contains('b-list__row--sticky')) return;

                    const titleEl = row.querySelector('.b-list__main__title');
                    const briefEl = row.querySelector('.b-list__brief');
                    const timeEl = row.querySelector('.b-list__time__edittime a');

                    if (titleEl && timeEl) {
                        const titleText = titleEl.innerText.trim();
                        const timeText = timeEl.innerText.trim();

                        if (excludeKeywords.some((keyword) => titleText.includes(keyword))) return;
                        const isRecent = validTimeKeywords.some((keyword) => timeText.includes(keyword));
                        if (!isRecent) return;

                        results.push({
                            title: titleText,
                            url: titleEl.getAttribute('href'),
                            time: timeText,
                            brief: briefEl ? briefEl.innerText.trim() : '',
                        });
                    }
                });
                return results;
            });

            const limitedPosts = allPosts.slice(0, limit);
            console.log(`   📊 取得 ${limitedPosts.length} 筆文章`);

            return { name: finalName, posts: limitedPosts };
        };

        const generateTable = (posts) => {
            if (posts.length === 0) return `*(無符合條件的文章)*\n`;
            let table = `| 文章標題 | 簡短說明 | 時間 |\n`;
            table += `| :--- | :--- | :--- |\n`;
            posts.forEach((post) => {
                const fullUrl = FORUM_BASE_URL + post.url;
                const safeBrief = post.brief.replace(/\n/g, ' ').replace(/\|/g, '｜');
                const briefDisplay = safeBrief.length > 50 ? safeBrief.substring(0, 50) + '...' : safeBrief;
                table += `| [${post.title}](${fullUrl}) | ${briefDisplay} | ${post.time} |\n`;
            });
            return table + '\n';
        };

        // --- 任務 B: 執行分眾爬取 ---
        if (HOT_BOARDS.length > 0) {
            markdownContent += `## 🛡️ 熱門看板 (近三日精選)\n`;
            for (const boardId of HOT_BOARDS) {
                const { name, posts } = await scrapeBoard(boardId, HOT_LIMIT, '熱門');
                markdownContent += `### ${name}\n`;
                markdownContent += generateTable(posts);
            }
        }

        if (COLD_BOARDS.length > 0) {
            markdownContent += `## ❄️ 冷門看板 (近三日精選)\n`;
            for (const boardId of COLD_BOARDS) {
                const { name, posts } = await scrapeBoard(boardId, COLD_LIMIT, '冷門');
                markdownContent += `### ${name}\n`;
                markdownContent += generateTable(posts);
            }
        }

        // --- 寫入檔案 ---
        fs.writeFileSync('README.md', markdownContent);
        console.log(`\n✅ 檔案已輸出: README.md`);

        // --- 關閉瀏覽器 ---
        await browser.close();
        console.log('\n👋 爬蟲任務結束');

        // --- 任務 C: Git 自動推送 ---
        console.log(`\n============== 🐙 正在執行 Git 推送 ==============`);
        try {
            console.log('1. 加入檔案 (git add)...');
            await runGitCommand('git add README.md');

            console.log('2. 提交變更 (git commit)...');
            const dateStr = new Date().toISOString().split('T')[0];
            await runGitCommand(`git commit -m "Daily News Update: ${dateStr}"`);

            console.log('3. 推送至遠端 (git push)...');
            await runGitCommand('git push');

            console.log('🎉 成功！最新新聞已推送到 GitHub。');
        } catch (gitError) {
            console.error('❌ Git 推送過程中發生錯誤 (請檢查 Git 設定或網路):');
            console.error(gitError);
        }
    } catch (error) {
        console.error('❌ 發生嚴重錯誤:', error);
        if (browser) await browser.close();
    }
})();
