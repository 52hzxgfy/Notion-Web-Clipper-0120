# Notion Web Clipper

一个基于 Express.js 的 Web 应用，可以方便地将网页内容保存到 Notion 数据库中。支持通过 AI 智能提取和手动选择两种方式保存内容。

## 功能特点

- 🔐 Notion OAuth2 授权集成
- 📚 自动创建 Notion 数据库
- 🤖 通过 Gemini AI 智能提取网页内容
- ✂️ 手动选择网页元素保存
- 🎯 保留原始排版格式
- 📝 自动生成摘要和关键词

## 技术栈

- 后端: Express.js
- AI: Google Gemini API
- 网页解析: Puppeteer, Cheerio
- 授权: Notion OAuth2
- 数据存储: Notion Database API

## 快速开始

### 环境要求

- Node.js >= 14
- npm >= 6

### 配置

1. 在 Notion 开发者平台创建应用并获取以下信息:
   - Client ID
   - Client Secret
   - Redirect URI

2. 创建 `.env` 文件并填入以下配置:
   
NOTION_CLIENT_ID=your_client_id

NOTION_CLIENT_SECRET=your_client_secret

NOTION_REDIRECT_URI=http://localhost:3000/auth/notion/callback

3. 获取 Gemini API Key 并在应用中配置

### 运行

npm start

访问 http://localhost:3000 开始使用

## 使用说明

### 1. 初始化设置

1. 点击"Notion授权"按钮完成 OAuth2 授权
2. 点击"创建Notion数据库"在工作区创建数据库
3. 输入 Gemini API Key

### 2. 保存网页内容

#### 方式一：AI 智能提取

1. 输入要保存的网页 URL
2. 点击"通过AI一键保存"
3. 等待 AI 处理并自动保存到 Notion

特点:
- 自动提取正文内容
- 生成摘要和关键词
- 保留文章格式
- 适合保存文章类网页

#### 方式二：手动选择

1. 输入要保存的网页 URL
2. 点击"使用元素选择器一键保存"
3. 在新窗口中选择要保存的内容
4. 点击确认保存到 Notion

特点:
- 灵活选择保存内容
- 支持多区域选择
- 保留原始排版
- 适合保存非文章类网页

## 数据库结构

Notion 数据库包含以下字段:
- Title: 页面标题
- URL: 原始网页链接
- Keywords: 关键词标签
- Summary: 内容摘要
- CreatedTime: 创建时间
