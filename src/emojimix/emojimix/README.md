# emoji 合成（emojimix）

从旧 bot 迁移（`C:\Users\server\onebot-bot\data\plugins\emojimix`）。

- 消息里出现两个 emoji（`😀😃` 或 `😀+😃`）自动合成
- Emoji Kitchen 图源：`https://www.gstatic.com/android/keyboard/emojikitchen/`
- 工具 `mix_emoji`：AI 聊天可调用
- 不支持/没有的组合会回复提示

新版用 Unicode 码点推导 gstatic 路径，不再内置几百个 emoji 的映射表；常见 emoji 都覆盖。
