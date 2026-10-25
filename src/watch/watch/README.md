# 祈歆状态（watch）

从旧 bot（`C:\Users\server\onebot-bot\data\plugins\watch`）迁移过来。

- 指令：`视奸祈歆`、`祈歆在干嘛`、`许雪然在干嘛`
- 接口：`https://home.inory.xin:9010/query`
- 工具：`get_qixin_status`（AI 聊天问「祈歆在干嘛」时可调用）
- 设置：接口、展示页、标题、模板、设备开关、别名、动作词

`priority = 10`，排在 AI 聊天前面；没命中的消息返回 `handled:false`，继续交给后面的插件。
