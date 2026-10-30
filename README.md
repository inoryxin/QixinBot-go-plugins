<p align="center"><img src="https://github.com/inoryxin/QixinBot-go/raw/main/branding/logo-128.png" width="84" alt="QixinBot"></p>

# QixinBot 插件仓库

QixinBot 官方插件的**源码**（`src/`）与**签名 `.anzu` 包**（`packages/`）。配套框架：
[QixinBot-go](https://github.com/inoryxin/QixinBot-go)。

每个插件的**说明文档在自己目录里**（`src/<插件>/README.md`），功能、指令、注意事项都在那里。

## 装一个插件

```powershell
copy packages\weather.anzu <框架目录>\plugins\
# 2 秒内框架自动装好（默认禁用，去控制台点「启用」）
```

或者在控制台「插件」页直接上传。全部插件的浏览和搜索在
[官网插件商店](http://10.0.0.123:8090/plugins)。

## 创建一个插件

```powershell
# 1. 在框架目录里生成骨架
<框架目录>\bin\qixinpack.exe new my-plugin -name 我的插件

# 2. 写代码（app/index.js）

# 3. 起本地环境，边改边测
cd my-plugin
..\bin\qixinpack.exe dev . -watch

# 4. 浏览器打开 http://127.0.0.1:7801（admin / dev）
#    → 聊天 → 🧪 虚拟群 → 发消息看插件怎么回

# 5. 测试通过就打包
..\bin\qixinpack.exe pack my-plugin -out my-plugin.anzu
```

完整开发手册：[插件开发手册](http://10.0.0.123:8090/guide/plugin-manual.html) ·
[快速开始](http://10.0.0.123:8090/guide/plugin-quickstart.html)。

## 提交你的插件

想让插件出现在[官网插件商店](http://10.0.0.123:8090/plugins)？发一个
[收录申请 Issue](https://github.com/inoryxin/QixinBot-go-plugins/issues/new?template=plugin-submission.yml)，
**只收签名公钥/指纹，不收私钥**——审核通过后展示，第三方插件的下载直链留在你自己的仓库。

## 其他文档

PC 管家、协议端（SnowLuma）等文档在本仓库的
[Wiki](https://github.com/inoryxin/QixinBot-go-plugins/wiki)。
