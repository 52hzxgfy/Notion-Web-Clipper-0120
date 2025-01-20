const express = require('express');
const axios = require('axios');
const fs = require('fs');
require('dotenv').config();

const app = express();
const port = 3000;
const tokens = new Map();
module.exports = { tokens, app };

// 启动时读本地 notion_tokens.json
const tokenFilePath='./notion_tokens.json';
if(fs.existsSync(tokenFilePath)){
    try{
        const raw=fs.readFileSync(tokenFilePath,'utf-8');
        const saved=JSON.parse(raw);
        for(const wsId in saved){
            tokens.set(wsId, saved[wsId]);
        }
        console.log('已从 notion_tokens.json 读取授权');
    } catch(e){
        console.error('读取 notion_tokens.json 出错:', e.message);
    }
}

app.use(express.static('public'));
app.use(express.json());

// OAuth
app.get('/auth/notion',(req,res)=>{
    const notionAuthUrl='https://api.notion.com/v1/oauth/authorize';
    const scopes=['read_user','read_databases','write_databases','read_pages','write_pages','create_pages'].join(' ');
    const authUrl=`${notionAuthUrl}?client_id=${process.env.NOTION_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.NOTION_REDIRECT_URI)}&response_type=code&owner=user&scope=${encodeURIComponent(scopes)}`;
    res.redirect(authUrl);
});

// 回调
app.get('/auth/notion/callback',async(req,res)=>{
    const {code}=req.query;
    if(!code) return res.status(400).send('Authorization code not found');

    try{
        const resp=await axios.post('https://api.notion.com/v1/oauth/token',{
            grant_type:'authorization_code',
            code,
            redirect_uri:process.env.NOTION_REDIRECT_URI
        },{
            headers:{
                'Authorization': 'Basic '+Buffer.from(`${process.env.NOTION_CLIENT_ID}:${process.env.NOTION_CLIENT_SECRET}`).toString('base64'),
                'Content-Type':'application/json'
            }
        });
        const {access_token, workspace_id}=resp.data;
        tokens.set(workspace_id,access_token);

        const tokenObj={};
        for(const [k,v] of tokens.entries()){
            tokenObj[k]=v;
        }
        fs.writeFileSync(tokenFilePath, JSON.stringify(tokenObj,null,2),'utf-8');

        res.send(`
          <script>
            window.opener && window.opener.postMessage({type:'NOTION_AUTH_SUCCESS'},'*');
            window.close();
          </script>
          <h1>授权成功，关闭此窗口</h1>
        `);
    } catch(e){
        console.log('交换token失败:', e.response?.data||e.message);
        res.status(500).send('授权失败:'+e.message);
    }
});

// 授权状态
app.get('/api/auth/status',(req,res)=>{
    res.json({authorized: tokens.size>0});
});

// 创建数据库
app.post('/api/create-database',async(req,res)=>{
    try {
        const access_token=Array.from(tokens.values())[0];
        if(!access_token){
            return res.status(401).json({success:false,error:'没授权'});
        }
        await axios.get('https://api.notion.com/v1/users/me',{
            headers:{Authorization:`Bearer ${access_token}`,'Notion-Version':'2022-06-28'}
        });
        const search=await axios.post('https://api.notion.com/v1/search',{
            filter:{property:'object',value:'page'},
            sort:{direction:'descending',timestamp:'last_edited_time'}
        },{
            headers:{
                Authorization:`Bearer ${access_token}`,
                'Notion-Version':'2022-06-28',
                'Content-Type':'application/json'
            }
        });
        const rootPage=search.data.results.find(pg=>pg.parent.type==='workspace'&&pg.parent.workspace);
        if(!rootPage){
            return res.status(404).json({success:false,error:'未找到工作区根页面'});
        }
        const dbResp=await axios.post('https://api.notion.com/v1/databases',{
            parent:{type:'page_id',page_id:rootPage.id},
            icon:{type:'emoji',emoji:'📝'},
            title:[{type:'text',text:{content:'Personal database'}}],
            properties:{
                Title:{"title":{}},
                URL:{"url":{}},
                Keywords:{"rich_text":{}},
                Summary:{"rich_text":{}},
                CreatedTime:{"date":{}}
            }
        },{
            headers:{
                Authorization:`Bearer ${access_token}`,
                'Notion-Version':'2022-06-28'
            }
        });
        const dbId=dbResp.data.id;
        const dbUrl=`https://notion.so/${dbId.replace(/-/g,'')}`;
        res.json({success:true,database_id:dbId,database_url:dbUrl});
    } catch(e){
        console.error('创建数据库失败:', e.response?.data||e.message);
        res.status(500).json({success:false,error:e.message,details:e.response?.data});
    }
});

app.use((req,res,next)=>{
    req.tokens=tokens;
    next();
});

const saveByAiRouter=require('./routes/saveByAi');
app.use('/api', saveByAiRouter);

app.listen(port,()=>{
    console.log(`服务已启动: http://localhost:${port}`);
});