# 博客（blog）

移植自旧 bot 的 Typecho 博客插件。

## 功能

- `/blog` 开始草稿，之后连续发文字/图片
- `/blog 写 主题` AI 生成并预览
- `/blog 发送` 发布
- `/blog 发送同步` 发布并同步 QQ 空间
- `/blog 取消`
- `/blog 测试` 测试 Typecho XML-RPC 连接
- 工具 `publish_blog` 直接发布
- 图片优先走站点 `upload.php`（Token），失败回退 `metaWeblog.newMediaObject`，再不行内嵌 data URL

## 设置

Typecho 地址、用户名、密码、分类、上传 Token、AI 风格、主人 QQ。

配置存在插件设置里，密码不会写进日志。

## 权限

`onebot.dangerous`（同步 QQ 空间需要）。
