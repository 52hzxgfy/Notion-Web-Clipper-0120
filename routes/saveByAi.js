const express = require('express');
const router = express.Router();
const puppeteer = require('puppeteer');
const axios = require('axios');
const path = require('path');
const { tokens } = require('../app');

// ------------  1) 这里是你AI的SYSTEM_PROMPT ------------
const SYSTEM_PROMPT = `你是一个网页内容提取助手。请帮我完成以下任务：
1. 清洗网页内容，保留以下元素和格式：
   - 主要文字内容
   - 图片(用markdown格式：![](图片URL))
   - 代码块(使用 \`\`\` 包裹)
   - 重要标题(使用 # ## ### 等标记)
   - 加粗文本(使用 **text**)
   - 引用内容(使用 > 标记)

+ 2. 删除一切无用或和正文无关的内容
+ 3. 如果遇到类似“平台链接：”“论文链接：”等指向性链接，也请忽略不保留
+ 4. 生成50字以内的摘要
+ 5. 生成5个关键词(逗号分隔)

返回格式：
---TITLE---
xxx
---KEYWORDS---
xxx
---SUMMARY---
xxx
---CONTENT---
xxx
`;

// ------------  2) 获取网页 => 转 Markdown ------------
async function fetchWebContentWithRetry(url, maxRetries = 3) {
    for(let i = 0; i < maxRetries; i++) {
        let browser;
        try {
            browser = await puppeteer.launch({
                headless: 'new',
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
            const page = await browser.newPage();
            await page.setDefaultNavigationTimeout(120000);
            // 确保图片等都加载完
            await page.goto(url, { waitUntil: 'networkidle0', timeout: 120000 });

            const title = await page.title();
            console.log('获取到页面标题：', title);

            // 转成 Markdown
            const markdown = await page.evaluate(() => {
                function nodeToMd(node) {
                    if (node.nodeType===3) return node.nodeValue||'';
                    if (node.nodeType!==1) return '';
                    const tag=node.tagName.toLowerCase();
                    if(tag==='img'){
                        const src=node.getAttribute('src')||'';
                        return src?`![](${src})\n`:'';
                    }
                    if(tag==='video'){
                        const src=node.getAttribute('src')||'';
                        return src?`[视频: ${src}]\n`:'';
                    }
                    if(tag==='pre')return `\`\`\`\n${node.innerText}\n\`\`\`\n`;
                    if(tag==='code')return `\`\`\`\n${node.innerText}\n\`\`\`\n`;
                    if(/^h[1-6]$/.test(tag)){
                        const lv=parseInt(tag.replace('h',''),10);
                        const hashes='#'.repeat(lv);
                        return `\n${hashes} ${node.innerText}\n`;
                    }
                    if(tag==='blockquote')return `\n> ${node.innerText}\n`;
                    const blockTags=['p','div','section','article','ul','ol','li','table','tbody','tr','td'];
                    let r='';
                    for(const c of node.childNodes)r+=nodeToMd(c);
                    if(blockTags.includes(tag))r+='\n';
                    return r;
                }
                const main=document.querySelector('article')||document.body;
                return nodeToMd(main);
            });

            await browser.close();
            return { title, content: markdown };
        } catch(e) {
            console.log(`第 ${i+1} 次获取失败：`, e.message);
            if (browser) await browser.close();
            if (i===maxRetries-1) throw e;
            await new Promise(r=>setTimeout(r,2000));
        }
    }
}

// ------------ 3) 调用 Gemini -------------
async function processWithGemini(content, apiKey) {
    const truncated=content.substring(0,30000);
    const url=`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${apiKey}`;
    try {
        const response=await axios.post(url,{
            contents:[{
                role:"user",
                parts:[{ text:`${SYSTEM_PROMPT}\n\n${truncated}` }]
            }],
            generationConfig:{
                temperature:0.5,topK:40,topP:0.95,maxOutputTokens:8192,
                responseMimeType:"text/plain"
            }
        },{
            headers:{'Content-Type':'application/json'}
        });
        const text=response.data.candidates?.[0]?.content?.parts?.[0]?.text||'';
        const sections={};
        let cur='';
        text.split('\n').forEach(line=>{
            if(line.startsWith('---')){
                cur=line.replace(/---/g,'').trim().toLowerCase();
            }else if(cur && line.trim()){
                sections[cur]=(sections[cur]?sections[cur]+'\n':'')+line;
            }
        });
        return {
            title: sections.title?.trim(),
            keywords: sections.keywords?.trim(),
            summary: sections.summary?.trim(),
            content: sections.content?.trim()
        };
    } catch(e){
        console.error('Gemini 出错:', e.message);
        throw e;
    }
}

// ------------ 4) 上传图片到 Notion “文件” ------------
async function uploadImageToNotion(imageUrl, notionToken, pageId) {
    // 先下载图片为 buffer
    const fileName = path.basename(imageUrl.split('?')[0]) || 'image.jpg';
    let fileBuffer;
    try {
        const imgResp=await axios.get(imageUrl,{responseType:'arraybuffer'});
        fileBuffer=Buffer.from(imgResp.data);
    } catch(e){
        console.log('下载图片失败:', imageUrl, e.message);
        return null; // 可根据需要 decide: return external link or skip
    }

    // POST /v1/files 创建上传
    let createFileResp;
    try {
        createFileResp=await axios.post(
            'https://api.notion.com/v1/files',
            {
                parent:{ type:'page_id', page_id: pageId },
                name: fileName
            },
            {
                headers:{
                    Authorization:`Bearer ${notionToken}`,
                    'Notion-Version':'2022-06-28',
                    'Content-Type':'application/json'
                }
            }
        );
    } catch(e){
        console.log('Notion创建文件记录失败:', e.response?.data||e.message);
        return null;
    }

    const { signed_url: signedUrl, file: { id: fileId }={} } = createFileResp.data;
    if(!signedUrl || !fileId){
        console.log('无有效signedUrl或fileId:', createFileResp.data);
        return null;
    }

    // 用 PUT 上传图片到s3
    try {
        await axios.put(signedUrl, fileBuffer, {
            headers: {
                'Content-Type': 'application/octet-stream'
            }
        });
    } catch(e){
        console.log('上传到S3失败:', e.message);
        return null;
    }

    // 返回 image block (type: file)
    return {
        object:'block',
        type:'image',
        image:{
            type:'file',
            file:{
                file_id: fileId,
                name: fileName
            }
        }
    };
}

// ------------ 5) 将 AI 生成的 Markdown 转成 Notion blocks，自动“真上传”图片 ------------
async function convertToNotionBlocks(content, notionToken, pageId) {
    if(!content) return [];
    const lines=content.split('\n');
    const blocks=[];
    let inCode=false, codeBuf='';

    for(const rawLine of lines){
        const line=rawLine.trim();
        // 代码块
        if(line.startsWith('```')){
            if(inCode){
                // 结束
                blocks.push({
                    object:'block', type:'code',
                    code:{
                        rich_text:[{ type:'text', text:{ content: codeBuf } }],
                        language:'plain'
                    }
                });
                inCode=false; codeBuf='';
            } else {
                inCode=true;
            }
            continue;
        }
        if(inCode){
            codeBuf+=(rawLine+'\n');
            continue;
        }

        // 引用
        if(line.startsWith('>')){
            blocks.push({
                object:'block', type:'quote',
                quote:{
                    rich_text:[{ type:'text', text:{content:line.replace(/^>\s*/,'')} }]
                }
            });
            continue;
        }
        // 标题
        if(line.startsWith('#')){
            const m=line.match(/^(#+)\s+(.*)/);
            if(m){
                const lv=m[1].length; 
                if(lv>=1 && lv<=3){
                    blocks.push({
                        object:'block', 
                        type:`heading_${lv}`,
                        [`heading_${lv}`]:{
                            rich_text:[{ type:'text', text:{content:m[2]} }]
                        }
                    });
                    continue;
                }
            }
        }

        // 图片 + 文字
        const imageRegex=/!$$.*?$$$(.*?)$/g;
        let lastIndex=0, match;
        let paragraphRich=[];
        while((match=imageRegex.exec(line))!==null){
            // 先拿前面的文字
            const before=line.slice(lastIndex, match.index);
            if(before.trim()){
                paragraphRich.push(... parseBoldText(before));
            }
            // 这里是真正上传
            const imageBlock=await uploadImageToNotion(match[1], notionToken, pageId);
            // 若上传失败，可回退 external
            if(imageBlock){
                // 先把已有的段落输出
                if(paragraphRich.length>0){
                    blocks.push({
                        object:'block', 
                        type:'paragraph',
                        paragraph:{ rich_text: paragraphRich }
                    });
                    paragraphRich=[];
                }
                blocks.push(imageBlock);
            } else {
                // 上传失败就当成外链
                // 也可 blocks.push(...some fallback)
                paragraphRich.push(... parseBoldText(`(图片加载失败 ${match[1]})`));
            }

            lastIndex=imageRegex.lastIndex;
        }
        const remaining=line.slice(lastIndex);
        if(remaining.trim()){
            paragraphRich.push(... parseBoldText(remaining));
        }
        if(paragraphRich.length>0){
            blocks.push({
                object:'block', type:'paragraph',
                paragraph:{ rich_text: paragraphRich }
            });
        }
    }

    return blocks;
}

// ------------ 6) 给加粗文本做简单解析 -------------
function parseBoldText(line){
    const tokens=[];
    let cur='', bold=false;
    for(let i=0;i<line.length;i++){
        if(line.slice(i,i+2)==='**'){
            if(cur){
                tokens.push({
                    type:'text',
                    text:{ content: cur },
                    annotations:{ bold }
                });
                cur='';
            }
            bold=!bold; i++;
        } else {
            cur+=line[i];
        }
    }
    if(cur){
        tokens.push({
            type:'text',
            text:{ content: cur },
            annotations:{ bold }
        });
    }
    return tokens;
}

// ===================== 路由 =======================

// AI 一键保存
router.post('/save-by-ai', async(req,res)=>{
    const {url, geminiApiKey}=req.body;
    if(!url) return res.status(400).json({success:false,error:'缺少URL'});
    if(!geminiApiKey)return res.status(400).json({success:false,error:'缺少GeminiKey'});

    try {
        const web=await fetchWebContentWithRetry(url);
        const processed=await processWithGemini(web.content, geminiApiKey);

        const notionToken=Array.from(req.tokens.values())[0];
        if(!notionToken){
            return res.status(401).json({success:false,error:'Notion未授权'});
        }

        // 找 Personal database
        const dbResp=await axios.post('https://api.notion.com/v1/search',{
            filter:{property:'object',value:'database'}
        },{
            headers:{Authorization:`Bearer ${notionToken}`,'Notion-Version':'2022-06-28'}
        });
        const personalDb=dbResp.data.results.find(d=>d.title?.[0]?.plain_text==='Personal database');
        if(!personalDb){
            throw new Error('没找到Personal database，请先创建');
        }

        // 先创建页面
        const pageResp=await axios.post('https://api.notion.com/v1/pages',{
            parent:{database_id:personalDb.id},
            properties:{
                Title:{title:[{text:{content: processed.title||web.title}}]},
                URL:{url},
                Keywords:{rich_text:[{text:{content: processed.keywords||''}}]},
                Summary:{rich_text:[{text:{content: processed.summary||''}}]},
                CreatedTime:{date:{start:new Date().toISOString()}}
            }
        },{
            headers:{
                Authorization:`Bearer ${notionToken}`,
                'Notion-Version':'2022-06-28',
                'Content-Type':'application/json'
            }
        });

        const pageId=pageResp.data.id;
        // 构建块
        const bodyBlocks=await convertToNotionBlocks(processed.content, notionToken, pageId);
        // 追加块
        await axios.patch(`https://api.notion.com/v1/blocks/${pageId}/children`,{
            children: bodyBlocks
        },{
            headers:{
                Authorization:`Bearer ${notionToken}`,
                'Notion-Version':'2022-06-28',
                'Content-Type':'application/json'
            }
        });

        res.json({success:true,pageUrl:pageResp.data.url});
    } catch(e){
        console.error('AI保存出错:', e.message);
        res.status(500).json({success:false,error:e.message,details:e.response?.data});
    }
});

// 元素选择器
router.post('/save-by-selector', async(req,res)=>{
    const {url, content}=req.body;
    if(!url||!content||!Array.isArray(content)){
        return res.status(400).json({success:false,error:'数据无效'});
    }
    try {
        const notionToken=Array.from(req.tokens.values())[0];
        if(!notionToken){
            return res.status(401).json({success:false,error:'Notion未授权'});
        }
        // 找 db
        const dbResp=await axios.post('https://api.notion.com/v1/search',{
            filter:{property:'object',value:'database'}
        },{
            headers:{Authorization:`Bearer ${notionToken}`,'Notion-Version':'2022-06-28'}
        });
        const personalDb=dbResp.data.results.find(d=>d.title?.[0]?.plain_text==='Personal database');
        if(!personalDb){
            return res.status(404).json({success:false,error:'未找到 Personal database'});
        }

        // 获取标题
        const pageTitle=await fetchPageTitle(url) || url;
        // 先创建空页面
        const pageResp=await axios.post('https://api.notion.com/v1/pages',{
            parent:{database_id:personalDb.id},
            properties:{
                Title:{title:[{text:{content:pageTitle}}]},
                URL:{url},
                Keywords:{rich_text:[{text:{content:'手动选择内容'}}]},
                Summary:{rich_text:[{text:{content:'元素选择器保存'}}]},
                CreatedTime:{date:{start:new Date().toISOString()}}
            }
        },{
            headers:{
                Authorization:`Bearer ${notionToken}`,
                'Notion-Version':'2022-06-28'
            }
        });

        const pageId=pageResp.data.id;

        // 将每个HTML转为 Notion blocks
        const cheerio=require('cheerio');
        const allBlocks=[];
        for(const snippet of content){
            const $=cheerio.load(snippet);
            // 处理最外层
            $(snippet).each(async(i,el)=>{
                const blocks=await parseHtmlToBlocks($,el,notionToken,pageId);
                if(blocks) allBlocks.push(...blocks);
            });
        }

        // 追加到页面
        if(allBlocks.length>0){
            await axios.patch(`https://api.notion.com/v1/blocks/${pageId}/children`,{
                children: allBlocks
            },{
                headers:{
                    Authorization:`Bearer ${notionToken}`,
                    'Notion-Version':'2022-06-28'
                }
            });
        }

        res.json({success:true,pageUrl:`https://notion.so/${pageId.replace(/-/g,'')}`});
    } catch(e){
        console.error('选择器保存出错:', e.message);
        res.status(500).json({success:false,error:e.message,details:e.response?.data});
    }
});

// 一个简单的函数获取网页标题
async function fetchPageTitle(url){
    let browser;
    try {
        browser=await puppeteer.launch({
            headless:'new',
            args:['--no-sandbox','--disable-setuid-sandbox']
        });
        const page=await browser.newPage();
        await page.setDefaultNavigationTimeout(15000);
        await page.goto(url,{waitUntil:'networkidle0',timeout:15000});
        const title=await page.title();
        await browser.close();
        return title||'';
    } catch(e){
        if(browser)await browser.close();
        return '';
    }
}

// 将一段HTML转为 blocks，里面的图片走上传
async function parseHtmlToBlocks($, el, notionToken, pageId) {
    const tag=el.tagName?.toLowerCase();
    if(!tag)return null;

    if(tag==='img'){
        const src=$(el).attr('src')||'';
        if(!src)return null;
        const block=await uploadImageToNotion(src, notionToken, pageId);
        return block?[block]:null;
    }
    if(/^h[1-3]$/.test(tag)){
        const lv=parseInt(tag.replace('h',''),10);
        const text=$(el).text();
        return [{
            object:'block',
            type:`heading_${lv}`,
            [`heading_${lv}`]:{
                rich_text: parseBoldText(text)
            }
        }];
    }
    if(tag==='blockquote'){
        const t=$(el).text();
        return [{
            object:'block',type:'quote',
            quote:{rich_text: parseBoldText(t)}
        }];
    }
    if(tag==='code'||tag==='pre'){
        const code=$(el).text()||'';
        return [{
            object:'block',type:'code',
            code:{rich_text:[{type:'text',text:{content:code}}],language:'plain'}
        }];
    }
    if(tag==='ul'){
        const items=[];
        $(el).children('li').each(async(_,liEl)=>{
            const liTxt=$(liEl).text()||'';
            items.push({
                object:'block',
                type:'bulleted_list_item',
                bulleted_list_item:{ rich_text: parseBoldText(liTxt) }
            });
        });
        return items;
    }

    // p,div,span,b,strong...
    if(['p','div','span','b','strong','i','em'].includes(tag)){
        return await parseChildrenAsParagraph($, el, notionToken, pageId);
    }

    // 兜底
    const txt=$(el).text().trim();
    if(txt){
        return [{
            object:'block',
            type:'paragraph',
            paragraph:{ rich_text: parseBoldText(txt)}
        }];
    }

    return null;
}

// 遍历子节点做一段段落
async function parseChildrenAsParagraph($, parentEl, notionToken, pageId){
    const blocks=[];
    let buffer='';

    for(const node of parentEl.childNodes){
        if(node.type==='text'){
            buffer+=node.data;
        } else if(node.type==='tag'){
            const name=node.tagName.toLowerCase();
            if(name==='img'){
                if(buffer.trim()){
                    blocks.push({
                        object:'block',type:'paragraph',
                        paragraph:{rich_text: parseBoldText(buffer.trim())}
                    });
                    buffer='';
                }
                const src=$(node).attr('src')||'';
                const block=await uploadImageToNotion(src, notionToken, pageId);
                if(block) blocks.push(block);
            } else if(name==='code'||name==='pre'){
                if(buffer.trim()){
                    blocks.push({
                        object:'block',type:'paragraph',
                        paragraph:{rich_text: parseBoldText(buffer.trim())}
                    });
                    buffer='';
                }
                const codeTxt=$(node).text()||'';
                blocks.push({
                    object:'block',type:'code',
                    code:{rich_text:[{type:'text',text:{content:codeTxt}}],language:'plain'}
                });
            } else {
                // 其他tag => 递归处理
                const subBlocks=await parseHtmlToBlocks($,node, notionToken, pageId);
                if(buffer.trim()){
                    blocks.push({
                        object:'block',type:'paragraph',
                        paragraph:{ rich_text: parseBoldText(buffer.trim())}
                    });
                    buffer='';
                }
                if(subBlocks) blocks.push(...subBlocks);
            }
        }
    }
    if(buffer.trim()){
        blocks.push({
            object:'block',type:'paragraph',
            paragraph:{ rich_text: parseBoldText(buffer.trim()) }
        });
    }
    return blocks;
}

// proxy 路由
router.get('/proxy', async(req,res)=>{
    const targetUrl=req.query.url;
    if(!targetUrl) return res.status(400).send('Missing url param');

    let browser;
    try {
        browser=await puppeteer.launch({
            headless:'new',
            args:['--no-sandbox','--disable-setuid-sandbox']
        });
        const page=await browser.newPage();
        await page.setDefaultNavigationTimeout(120000);
        await page.goto(targetUrl,{waitUntil:'networkidle0',timeout:120000});
        const html=await page.content();
        await browser.close();

        const injected=html.replace('</head>',
          `<style>
            .selector-hover{
                outline:2px dashed #ff4444 !important; cursor:pointer;
            }
            .selector-selected{
                outline:2px solid #007bff !important;
            }
          </style></head>`
        );
        res.setHeader('Content-Type','text/html;charset=utf-8');
        res.setHeader('Access-Control-Allow-Origin','*');
        res.send(injected);

    } catch(e){
        if(browser) await browser.close();
        console.log('proxy error:', e.message);
        res.status(500).send('代理失败:'+e.message);
    }
});

module.exports = router;