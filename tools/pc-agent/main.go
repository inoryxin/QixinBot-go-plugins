package main

import (
    "context"
    "encoding/base64"
    "encoding/json"
    "flag"
    "fmt"
    "io"
    "log"
    "net"
    "net/http"
    "os"
    "os/exec"
    "path/filepath"
    "runtime"
    "strings"
    "syscall"
    "time"
    "unicode/utf16"
)

var (
    port  = flag.Int("port", 3097, "listen port")
    token = flag.String("token", "pc-7f3a91c2", "bearer token")
)

var (
    home    = os.Getenv("USERPROFILE")
    dshHome = filepath.Join(home, ".dsh")
    repo    = `D:\deepseek\deepseek-harness`
    logDir  = filepath.Join(dshHome, "logs")
    logFile = filepath.Join(logDir, "pc-agent.log")
    webOut  = filepath.Join(logDir, "dsh-web.out.log")
    webUrl  = filepath.Join(dshHome, "web-url.txt")
)

func init() {
    _ = os.MkdirAll(logDir, 0o755)
    _ = os.MkdirAll(filepath.Join(dshHome, "qq-uploads"), 0o755)
    _ = os.MkdirAll(filepath.Join(logDir, "screens"), 0o755)
}

func logf(format string, args ...any) {
    line := fmt.Sprintf("%s %s\n", time.Now().Format(time.RFC3339), fmt.Sprintf(format, args...))
    f, err := os.OpenFile(logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
    if err == nil { _, _ = f.WriteString(line); _ = f.Close() }
}
func readFile(p string) []byte { b, _ := os.ReadFile(p); return b }

func powerShell(script string, timeout time.Duration) ([]byte, error) {
    u := utf16.Encode([]rune(script))
    raw := make([]byte, len(u)*2)
    for i, v := range u {
        raw[i*2] = byte(v)
        raw[i*2+1] = byte(v >> 8)
    }
    encoded := base64.StdEncoding.EncodeToString(raw)
    ctx, cancel := context.WithTimeout(context.Background(), timeout)
    defer cancel()
    cmd := exec.CommandContext(ctx, "powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded)
    cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
    return cmd.Output()
}

func portOpen(p int, timeout time.Duration) bool {
    c, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", p), timeout)
    if err != nil { return false }
    _ = c.Close()
    return true
}

func startDetached(name string, args []string, dir, logName string, extraEnv ...string) (int, error) {
    logPath := filepath.Join(logDir, logName+".out.log")
    f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
    if err != nil {
        logPath = filepath.Join(os.TempDir(), "pc-agent-"+logName+".log")
        f, err = os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
        if err != nil {
            f, err = os.OpenFile(os.DevNull, os.O_WRONLY, 0)
            if err != nil { return 0, err }
        }
    }
    cmd := exec.Command(name, args...)
    cmd.Dir = dir
    cmd.Stdout = f
    cmd.Stderr = f
    if len(extraEnv) > 0 { cmd.Env = append(os.Environ(), extraEnv...) }
    cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x00000010 | 0x00000200}
    if err := cmd.Start(); err != nil { _ = f.Close(); logf("%s start error: %v", logName, err); return 0, err }
    pid := cmd.Process.Pid
    _ = cmd.Process.Release()
    _ = f.Close()
    logf("%s started pid=%d", logName, pid)
    return pid, nil
}

func readWebURL() string {
    data := readFile(webOut)
    text := string(data)
    best := ""
    for {
        i := strings.Index(text, "http")
        if i < 0 { break }
        text = text[i:]
        j := strings.IndexAny(text, " \r\n\t\"")
        candidate := text
        if j >= 0 { candidate = text[:j] }
        if strings.Contains(candidate, "?token=") { best = candidate }
        if j < 0 { break }
        text = text[j+1:]
    }
    if best != "" { return best }
    b, _ := os.ReadFile(webUrl)
    return strings.TrimSpace(string(b))
}

type statusResp struct {
    Host      string        `json:"host"`
    Platform  string        `json:"platform"`
    UptimeSec int64         `json:"uptimeSec"`
    CPU       cpuInfo       `json:"cpu"`
    Memory    memInfo       `json:"memory"`
    Disks     []diskInfo    `json:"disks"`
    Battery   *batteryInfo  `json:"battery"`
    DSH       map[string]any `json:"dsh"`
    TS        int64         `json:"ts"`
}
type cpuInfo struct { Model string `json:"model"`; Cores int `json:"cores"`; Load []float64 `json:"load"` }
type memInfo struct { Total uint64 `json:"total"`; Free uint64 `json:"free"` }
type diskInfo struct { Name string `json:"name"`; Total uint64 `json:"total"`; Free uint64 `json:"free"` }
type batteryInfo struct { Percent int `json:"percent"` }

func getStatus() statusResp {
    host, _ := os.Hostname()
    out := statusResp{Host: host, Platform: fmt.Sprintf("%s %s (%s)", runtime.GOOS, "10", runtime.GOARCH), CPU: cpuInfo{Model: "CPU", Cores: runtime.NumCPU(), Load: []float64{0,0,0}}, DSH: map[string]any{"web": portOpen(3080, 500*time.Millisecond), "bridge": portOpen(3099, 500*time.Millisecond), "agent": true}, TS: time.Now().UnixMilli()}
    script := `$ErrorActionPreference='SilentlyContinue'
$os=Get-CimInstance Win32_OperatingSystem
$cpu=Get-CimInstance Win32_Processor | Select-Object -First 1
$d=Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { [pscustomobject]@{name=$_.DeviceID;total=[double]$_.Size;free=[double]$_.FreeSpace} }
$b=Get-CimInstance Win32_Battery | Select-Object -First 1
[pscustomobject]@{uptimeSec=[int64]((Get-Date)-$os.LastBootUpTime).TotalSeconds;cpu=$cpu.Name;cores=[int]$cpu.NumberOfLogicalProcessors;total=[double]$os.TotalVisibleMemorySize*1024;free=[double]$os.FreePhysicalMemory*1024;disks=@($d);battery=if($b){[int]$b.EstimatedChargeRemaining}else{$null}} | ConvertTo-Json -Depth 5 -Compress`
    if raw, err := powerShell(script, 20*time.Second); err == nil {
        var x struct {
            UptimeSec int64 `json:"uptimeSec"`; CPU string `json:"cpu"`; Cores int `json:"cores"`
            Total float64 `json:"total"`; Free float64 `json:"free"`; Disks []struct{Name string `json:"name"`;Total float64 `json:"total"`;Free float64 `json:"free"`} `json:"disks"`; Battery *int `json:"battery"`
        }
        if json.Unmarshal(raw, &x) == nil {
            out.UptimeSec = x.UptimeSec
            if x.CPU != "" { out.CPU.Model = x.CPU }
            if x.Cores > 0 { out.CPU.Cores = x.Cores }
            out.Memory.Total = uint64(x.Total); out.Memory.Free = uint64(x.Free)
            for _, d := range x.Disks { out.Disks = append(out.Disks, diskInfo{Name: d.Name, Total: uint64(d.Total), Free: uint64(d.Free)}) }
            if x.Battery != nil { out.Battery = &batteryInfo{Percent: *x.Battery} }
        }
    }
    return out
}

func screenshot() (string, error) {
    file := filepath.Join(logDir, "screens", fmt.Sprintf("screen-%d.jpg", time.Now().UnixNano()))
    script := fmt.Sprintf(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b=[System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size)
$bmp.Save('%s',[System.Drawing.Imaging.ImageFormat]::Jpeg)
$g.Dispose();$bmp.Dispose()`, strings.ReplaceAll(file, "'", "''"))
    _, err := powerShell(script, 20*time.Second)
    return file, err
}

func ensureDSH(withWeb bool) map[string]any {
    res := map[string]any{"bridge": map[string]any{"ready": false, "started": false}, "web": map[string]any{"ready": false, "started": false, "url": ""}}
    b := res["bridge"].(map[string]any); w := res["web"].(map[string]any)
    if !portOpen(3099, 500*time.Millisecond) {
        launcher := filepath.Join(dshHome, "dsh-acp-bridge.vbs")
        bridge := filepath.Join(dshHome, "acp-bridge.js")
        if _, err := os.Stat(launcher); err == nil {
            if _, err := startDetached("wscript.exe", []string{launcher}, home, "acp-bridge"); err == nil { b["started"] = true } else { b["error"] = err.Error() }
        } else if _, err := os.Stat(bridge); err == nil {
            if _, err := startDetached(nodePath(), []string{bridge}, dshHome, "acp-bridge", "DSH_ACP_TOKEN=111111", "DSH_ACP_PORT=3099", "DSH_META_PORT=3098", "DSH_HOME="+dshHome); err == nil { b["started"] = true } else { b["error"] = err.Error() }
        } else { b["error"] = "缺少 " + bridge }
    }
    b["ready"] = waitPort(3099, 15*time.Second)
    if withWeb {
        if !portOpen(3080, 500*time.Millisecond) {
            if _, err := startDetached(nodePath(), []string{"--import", "tsx/esm", "apps/cli/src/bin.ts", "web", "--no-open"}, repo, "dsh-web", "DSH_HOME="+dshHome); err == nil { w["started"] = true }
        }
        w["ready"] = waitPort(3080, 45*time.Second)
        w["url"] = readWebURL()
    } else {
        w["ready"] = portOpen(3080, 500*time.Millisecond)
        if w["ready"].(bool) { w["url"] = readWebURL() }
    }
    return res
}

func nodePath() string {
    if p, err := exec.LookPath("node.exe"); err == nil { return p }
    return `C:\Program Files\nodejs\node.exe`
}
func waitPort(p int, d time.Duration) bool {
    end := time.Now().Add(d)
    for time.Now().Before(end) { if portOpen(p, 500*time.Millisecond) { return true }; time.Sleep(800*time.Millisecond) }
    return false
}

func auth(r *http.Request) bool { return r.Header.Get("Authorization") == "Bearer "+*token }
func writeJSON(w http.ResponseWriter, code int, v any) { w.Header().Set("Content-Type", "application/json; charset=utf-8"); w.WriteHeader(code); _ = json.NewEncoder(w).Encode(v) }

func main() {
    flag.Parse()
    mux := http.NewServeMux()
    mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) { writeJSON(w, 200, map[string]any{"ok": true}) })
    mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
        if !auth(r) { writeJSON(w, 401, map[string]any{"error": "unauthorized"}); return }
        switch {
        case r.Method == "GET" && r.URL.Path == "/status":
            writeJSON(w, 200, getStatus())
        case r.Method == "GET" && r.URL.Path == "/dsh-url":
            writeJSON(w, 200, map[string]any{"url": readWebURL()})
        case r.Method == "POST" && r.URL.Path == "/ensure-dsh":
            writeJSON(w, 200, ensureDSH(r.URL.Query().Get("web") == "1"))
        case r.Method == "GET" && r.URL.Path == "/screen":
            file, err := screenshot()
            if err != nil { writeJSON(w, 500, map[string]any{"error": err.Error()}); return }
            data, err := os.ReadFile(file)
            if err != nil { writeJSON(w, 500, map[string]any{"error": err.Error()}); return }
            _ = os.Remove(file)
            w.Header().Set("Content-Type", "image/jpeg"); _, _ = w.Write(data)
        case r.Method == "POST" && r.URL.Path == "/open":
            u := r.URL.Query().Get("url")
            if u == "" { var body struct{URL string `json:"url"`}; _ = json.NewDecoder(r.Body).Decode(&body); u = body.URL }
            if !strings.HasPrefix(u, "http") { writeJSON(w, 400, map[string]any{"error": "need http url"}); return }
            _, _ = startDetached("cmd.exe", []string{"/c", "start", "", u}, home, "open")
            writeJSON(w, 200, map[string]any{"ok": true})
        case r.Method == "POST" && r.URL.Path == "/action":
            a := r.URL.Query().Get("action")
            if a == "" { var body struct{Action string `json:"action"`}; _ = json.NewDecoder(r.Body).Decode(&body); a = body.Action }
            cmd := map[string][]string{"shutdown": {"shutdown.exe","/s","/t","0"}, "restart": {"shutdown.exe","/r","/t","0"}, "sleep": {"rundll32.exe","powrprof.dll,SetSuspendState","0,1,0"}, "hibernate": {"shutdown.exe","/h"}, "lock": {"rundll32.exe","user32.dll,LockWorkStation"}, "logoff": {"shutdown.exe","/l"}}[a]
            if cmd == nil { writeJSON(w, 400, map[string]any{"error": "unknown action"}); return }
            _, _ = startDetached(cmd[0], cmd[1:], home, "action")
            writeJSON(w, 200, map[string]any{"ok": true, "action": a})
        case r.Method == "POST" && r.URL.Path == "/shell":
            var body struct{Command string `json:"command"`}; _ = json.NewDecoder(r.Body).Decode(&body)
            if body.Command == "" { writeJSON(w, 400, map[string]any{"error": "need command"}); return }
            raw, err := powerShell(body.Command, 60*time.Second)
            if err != nil { writeJSON(w, 500, map[string]any{"error": err.Error()}); return }
            writeJSON(w, 200, map[string]any{"ok": true, "output": string(raw)})
        case r.Method == "POST" && r.URL.Path == "/upload":
            name := filepath.Base(r.URL.Query().Get("name"))
            if name == "" { name = fmt.Sprintf("upload-%d.bin", time.Now().UnixNano()) }
            data, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
            if err != nil { writeJSON(w, 500, map[string]any{"error": err.Error()}); return }
            file := filepath.Join(dshHome, "qq-uploads", name)
            if err := os.WriteFile(file, data, 0o644); err != nil { writeJSON(w, 500, map[string]any{"error": err.Error()}); return }
            writeJSON(w, 200, map[string]any{"ok": true, "path": file, "bytes": len(data)})
        case r.Method == "GET" && r.URL.Path == "/file":
            file := r.URL.Query().Get("path")
            if file == "" { writeJSON(w, 400, map[string]any{"error": "need path"}); return }
            data, err := os.ReadFile(file)
            if err != nil { writeJSON(w, 404, map[string]any{"error": "not found"}); return }
            w.WriteHeader(200); _, _ = w.Write(data)
        default:
            writeJSON(w, 404, map[string]any{"error": "not found"})
        }
    })
    logf("pc-agent-go listening :%d", *port)
    log.Fatal(http.ListenAndServe(fmt.Sprintf("0.0.0.0:%d", *port), mux))
}
