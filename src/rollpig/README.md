# 抽小猪（rollpig）

从旧 bot 迁移（`C:\Users\server\onebot-bot\data\plugins\rollpig`）。

- `今日小猪 [@某人]`：按用户 + 日期抽固定的一只
- `随机小猪 [1-10]`：随机抽
- `找猪 <关键词>` / `找猪 -i <ID>`：搜索
- 工具 `roll_pig`：AI 聊天里「抽只小猪」可调用

图源：PigHub（`https://pighub.top`），缓存 1 小时。

旧版用 `@napi-rs/canvas` 合成卡片；新版为了不引入原生依赖，直接发原图 + 文字分析。
