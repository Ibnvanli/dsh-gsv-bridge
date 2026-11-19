# dsh-gsv-bridge

DeepSeek Harness 与本机 GPT-SoVITS 之间的桥接插件。

只做请求转发与音频落盘，**不启动推理服务、不修改系统、不注入界面**。

- 版本：`0.3.0`
- 协议：MIT

## 解决的问题

GPT-SoVITS 提供两套 HTTP API，端点与参数名不同，且都会返回 `application/json`：

| | `api.py` | `api_v2.py` |
|---|---|---|
| 合成端点 | `POST /` | `POST /tts` |
| 文本字段 | `text`, `text_language` | `text`, `text_lang` |
| 参考音频 | `refer_wav_path` | `ref_audio_path` |
| 参考文本 | `prompt_text`, `prompt_language` | `prompt_text`, `prompt_lang` |
| 附加字段 | `media_type`, `streaming_mode`, `text_split_method` | — |

判断方式不能依赖「有没有返回 JSON」：`api_v2` 的 `GET /` 返回 `404 {"detail":"Not Found"}`，
按 JSON 判定会误认为服务在线，随后 `POST /` 再收到 404，表现为**连接成功但合成必然失败**。

本插件的判定方式：

1. 读取 `/openapi.json` 的路由表——存在 `/tts` 判为 `api_v2`，存在 `/` 或 `/change_refer` 判为 `api`
2. 探针不接受 404 或 HTML 响应，仅真实音频或带业务语义的错误视为在线
3. 按识别结果分别构造请求体与端点

## 功能

- 自动探测端口（9880 / 9872 / 9874，可扩展）与 API 方言
- 合成接口 `POST /say`，支持逐次覆盖参考音频、文本、语种与采样参数
- 界面朗读按钮：每条助手回复下方提供播放/停止
- 最近成败记录 `GET /logs`，用于排查「点击无反应」
- 音频落盘与读取接口

## 安装

```bash
cd /path/to/workspace
dsh plugin --profile desktop add ./dsh-gsv-bridge
```

安装后重启 DSH。

## 前置条件

需要本机已运行 GPT-SoVITS 推理服务，并提供一段参考音频与其对应文本（零样本推理）。

确认服务在线：

```bash
curl -s http://127.0.0.1:9880/openapi.json | python3 -c "import sys,json;print(list(json.load(sys.stdin)['paths']))"
```

`api_v2` 还应支持 `/set_gpt_weights`、`/set_sovits_weights`、`/set_refer_audio`，
可用于热切换权重，插件不做拦截。

## 配置

位于 `cordis.patch.yml` 的 `config:` 段。

| 字段 | 默认值 | 说明 |
|---|---|---|
| `host` | `127.0.0.1` | API 地址 |
| `port` | `0` | `0` 表示自动探测；填数字则直连 |
| `extraPorts` | `[]` | 额外的探测端口 |
| `dialect` | `auto` | `auto` / `api` / `api_v2`，自动识别通常足够 |
| `referWavPath` | 空 | 参考音频绝对路径 |
| `promptText` | 空 | 参考音频原文 |
| `promptLanguage` | `zh` | 参考音频语种 |
| `textLanguage` | `zh` | 合成文本语种 |
| `timeoutMs` | `120000` | CPU 推理耗时较长，不宜调小 |
| `outDir` | 空 | 为空时写入 `~/.dsh/gsv-bridge-out` |

## 接口

### 状态探测

```bash
curl http://127.0.0.1:<DSH端口>/dsh-gsv-bridge/status
curl http://127.0.0.1:<DSH端口>/dsh-gsv-bridge/probe
```

### 合成

```bash
curl -X POST http://127.0.0.1:<DSH端口>/dsh-gsv-bridge/say \
  -H 'content-type: application/json' \
  -d '{"text":"示例文本"}'
```

返回：

```json
{"ok":true,"file":"...wav","bytes":0,"audioUrl":"/dsh-gsv-bridge/audio?file=...","port":9880,"dialect":"api_v2"}
```

支持单次覆盖的参数：`referWavPath`（或 `refAudioPath`）、`promptText`、`promptLanguage`、
`textLanguage`、`top_k`、`top_p`、`temperature`、`speed`（`api_v2` 映射为 `speed_factor`）、
`cut_punc`（`api`）、`batch_size`（`api_v2`）。

### 取音频

```bash
curl 'http://127.0.0.1:<DSH端口>/dsh-gsv-bridge/audio?file=xxx.wav' -o out.wav
```

仅接受符合 `数字-字母.wav` 形式的文件名，避免目录穿越。

### 界面朗读

```bash
curl -X POST http://127.0.0.1:<DSH端口>/dsh-gsv-bridge/speak \
  -H 'content-type: application/json' \
  -d '{"sessionId":"session-xxx","messageId":"msg-xxx"}'
```

- 客户端插槽：`conversation.chat.assistant-actions`，`order: 31`
- 文本预清洗：剥离颜文字、代码块、Markdown 链接、裸 URL、表格竖线后再送入合成
- 仅接受 `messageId`，单条上限 800 字
- 同一时间只播放一条，切换时自动停止上一条

### 运行记录

```bash
curl 'http://127.0.0.1:<DSH端口>/dsh-gsv-bridge/logs?n=20'
```

内存中保留最近 60 条，DSH 重启后清空。失败条目含 `error`，成功条目含 `file` 与来源。

## 已知限制

**推理速度受 CPU 制约。** 实测 M1 CPU 上合成 4.84 秒音频耗时约 95 秒（约 20 倍实时）。
该数值取决于硬件与模型规模，插件层不参与推理，也不应因此调整。

适用于离线配音，不适用于实时语音对话。

**权重目录。** 若使用自训练权重，需保证其落在服务端配置的权重目录内，
并通过热切换端点加载。插件不管理模型文件。

## 后续优化方向

按性价比排序，均未实现：

1. **短句优先** —— 按句切分逐句合成与播放，总时长不变但首句延迟显著降低
2. **流式合成** —— `api_v2` 的 `streaming_mode: 3`，以质量换首字延迟
3. **结果缓存** —— 以 `hash(text + 参数)` 为键复用已有音频
4. **进程守护** —— 服务掉线时自动拉起
5. **请求排队** —— `api_v2` 为单 worker，并发请求需串行化并反馈排队位置
6. **权重热切换封装** —— 将三个 set 端点合并为单次调用
7. **长文本分段拼接** —— 按句切分后合成并拼接为单个文件
8. **mp3 / ogg 输出** —— 减小文件体积
9. **输出目录定期清理**

## 边界

- 不启动、停止或重启推理服务
- 不管理、不下载模型权重
- 仅写入 `outDir`（默认位于 `~/.dsh` 下）
- 所有失败均返回明确 JSON，不静默降级，不将 HTML 或 404 响应视为音频
