## K2 Think Demo Proxy · OpenAI 兼容 + Cherry 折叠思考适配

练手小项目，留作纪念，仅此而已。

一个可直接部署到 Cloudflare Workers 的代理服务，转发到 K2 Think 官方演示接口 `https://www.k2think.ai/api/guest/chat/completions`，并提供 OpenAI 兼容端点、模型列表伪装、流式 SSE 规范化，以及对 Cherry Studio 的“思考自动折叠”适配。

### 快速开始

- 复制 `worker.js` 全部内容，粘贴到 Cloudflare Dashboard 的 Workers 编辑器中，保存并部署；或
- 本地使用 Wrangler 部署：

```bash
wrangler dev
wrangler deploy
```

部署成功后，将得到你的 `*.workers.dev` 域名，或自定义域名。

### 接口与功能

- `POST /api/guest/chat/completions`：原样转发到上游
- `POST /v1/chat/completions`：OpenAI 兼容端点（见下文协议与扩展）
- `GET  /v1/models`：返回唯一模型 `MBZUAI-IFM/K2-Think`
- `GET  /v1/models/MBZUAI-IFM/K2-Think`：返回单个模型对象
- `GET  /health`：健康检查

均已开启 CORS（`Access-Control-Allow-Origin: *`），支持预检 `OPTIONS`。

### 上游信息

- 上游基址：`https://www.k2think.ai`
- 目标路径：`/api/guest/chat/completions`

如需修改，请在 `worker.js` 顶部调整常量：

```js
const UPSTREAM_BASE = 'https://www.k2think.ai';
const UPSTREAM_PATH = '/api/guest/chat/completions';
```

### OpenAI 兼容：协议与扩展

1) 模型与别名
- 模型 ID：`MBZUAI-IFM/K2-Think`
- 接受别名：`K2-Think` / `k2think` / `k2-think` / `k2`

2) 非流式（JSON）

```bash
curl -sS -X POST \
  https://<your-worker>.workers.dev/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "MBZUAI-IFM/K2-Think",
    "messages": [
      {"role":"user","content":"你好,请问你是什么模型"}
    ]
  }'
```

3) 流式（SSE）
- 客户端发送 `"stream": true`
- 代理从上游取回 JSON，并合成 OpenAI 规范的 SSE 分片：
  - 首分片：`choices[].delta.role = "assistant"`
  - 可选思考分片：`choices[].delta.reasoning_content = "..."`
  - 答案分片：`choices[].delta.content = "..."`
  - 结束分片：`finish_reason = "stop"`，随后 `[DONE]`
- 可选参数：
  - `chunk_delay_ms`: 分片发送间隔（毫秒，0–2000），例如 `?chunk_delay_ms=80` 可让 Cherry 显示更自然的“思考中”动画。

4) 无换行（仅影响答案正文）
- Query：`?flat=1` 或请求头 `x-flat: 1`
- 仅对答案文本去换行；思考文本保留原始格式。

### 示例

获取模型列表示例：

```bash
curl -sS https://<your-worker>.workers.dev/v1/models | jq
```

返回结构（示例）：

```json
{
  "object": "list",
  "data": [
    {
      "id": "MBZUAI-IFM/K2-Think",
      "object": "model",
      "created": 1720000000,
      "owned_by": "MBZUAI-IFM",
      "root": "MBZUAI-IFM/K2-Think",
      "parent": null
    }
  ]
}
```

### 目录结构

- `worker.js`：Cloudflare Worker 脚本
- `wrangler.toml`：Wrangler 配置
- `README.md`、`LICENSE`、`.gitignore`

### 注意事项

- 代理会移除上游的 `content-length`/`content-encoding`/`transfer-encoding` 等不适合 Workers 的头，保留 `content-type` 与响应体。
- CORS 默认放开 `*`，可在 `corsHeaders` 内收敛到白名单域。
- 别名自动映射：`K2-Think`/`k2think`/`k2-think`/`k2`。
- Cherry 折叠思考：非流式用 `message.reasoning_content`，流式用 `delta.reasoning_content`。

### 免责声明

- 本项目仅用于学习、研究与互操作性测试目的，不提供任何形式的担保或承诺。
- 使用者须确保遵守所在司法辖区法律法规、目标站点与 Cloudflare 的条款与规范。
- 请勿用于绕过鉴权、批量抓取/爬虫、滥用或其他可能干扰对方服务的行为；风险与后果由使用者自负。
- 与 MBZUAI、IFM、k2think.ai、Cherry Studio、Cloudflare 无关，相关权利归原权利人所有。

### 开源协议（License）

本项目采用 MIT License，详见 LICENSE 文件。

### Cherry Studio 配置

- Provider：OpenAI Compatible（自定义）
- Base URL：`https://<your-worker>.workers.dev`
- API Key：任意非空（如 `sk-xxx`）
- 获取模型：选择 `MBZUAI-IFM/K2-Think`
- 如列表加载失败，可直接访问 `/v1/models` 验证
