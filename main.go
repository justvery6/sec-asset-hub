package main

import (
	"context"
	"embed"
	"encoding/csv"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

//go:embed static/*
var staticFiles embed.FS
var db *gorm.DB
var jwtKey = []byte("sec-guard-super-secret-key-2026")

// ==========================================
// 1. 数据库模型定义
// ==========================================
type Team struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	Name      string    `gorm:"unique" json:"name"`
	Desc      string    `json:"desc"`
	CreatedAt time.Time `json:"created_at"`
}

type User struct {
	ID       uint   `gorm:"primaryKey" json:"id"`
	Username string `gorm:"unique" json:"username"`
	Password string `json:"password,omitempty"`
	Team     string `json:"team"`
	Role     string `json:"role"` // admin 或 user
}

type Asset struct {
	ID          uint           `gorm:"primaryKey" json:"id"`
	Name        string         `json:"name"`
	Type        string         `json:"type"`       // IP 或 URL
	IPAddress   string         `json:"ip_address"` // 拆分 IP
	URLPath     string         `json:"url_path"`   // 拆分 URL
	Port        string         `json:"port"`       // 拆分 端口
	Project     string         `json:"project"`
	Purpose     string         `json:"purpose"`
	Team        string         `json:"team"`
	Admin       string         `json:"admin"`
	Environment string         `json:"environment"` // PRD/UAT/DEV
	IsPublic    bool           `json:"is_public"`   // 是否公网
	DataLevel   string         `json:"data_level"`  // L1-L4
	Status      string         `json:"status"`      // 运行中/维护中
	CreatedAt   time.Time      `json:"created_at"`
	UpdatedAt   time.Time      `json:"updated_at"`
	DeletedAt   gorm.DeletedAt `gorm:"index" json:"-"` // 软删除标记
}

type Announcement struct {
	ID        uint      `gorm:"primaryKey" json:"id"`
	Title     string    `json:"title"`
	Content   string    `json:"content"`
	Sender    string    `json:"sender"`
	Targets   string    `json:"targets"` // ALL 或逗号分隔的用户名
	CreatedAt time.Time `json:"created_at"`
}

type CustomClaims struct {
	Username string `json:"username"`
	Team     string `json:"team"`
	Role     string `json:"role"`
	jwt.RegisteredClaims
}

// ==========================================
// 2. 初始化与基础配置
// ==========================================
func initDB() {
	var err error
	db, err = gorm.Open(sqlite.Open("assets.db"), &gorm.Config{
		Logger: logger.Default.LogMode(logger.Silent),
	})
	if err != nil {
		log.Fatal("数据库连接失败:", err)
	}

	db.AutoMigrate(&Team{}, &User{}, &Asset{}, &Announcement{})

	var count int64
	db.Model(&Team{}).Count(&count)
	if count == 0 {
		db.Create(&[]Team{
			{Name: "安全运营", Desc: "负责系统日常安全监测与运营"},
			{Name: "研发团队", Desc: "负责业务系统开发与维护"},
		})

		hash, _ := bcrypt.GenerateFromPassword([]byte("123456"), bcrypt.DefaultCost)
		db.Create(&User{Username: "admin", Password: string(hash), Team: "安全运营", Role: "admin"})
		db.Create(&User{Username: "test", Password: string(hash), Team: "研发团队", Role: "user"})

		db.Create(&Announcement{
			Title:   "欢迎使用北实万象资产管理平台",
			Content: "系统已升级至最新生产版本，支持多维资产测绘、批量导入及历史追溯。请各团队及时同步资产信息。",
			Sender:  "System",
			Targets: "ALL",
		})
	}
}

// ==========================================
// 3. 鉴权中间件
// ==========================================
func AuthMiddleware(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		authHeader := r.Header.Get("Authorization")
		if !strings.HasPrefix(authHeader, "Bearer ") {
			http.Error(w, "Unauthorized", 401)
			return
		}
		tokenString := strings.TrimPrefix(authHeader, "Bearer ")
		claims := &CustomClaims{}
		token, err := jwt.ParseWithClaims(tokenString, claims, func(t *jwt.Token) (interface{}, error) { return jwtKey, nil })
		if err != nil || !token.Valid {
			http.Error(w, "Invalid Token", 401)
			return
		}
		ctx := context.WithValue(r.Context(), "user", claims)
		next.ServeHTTP(w, r.WithContext(ctx))
	}
}

func AdminOnly(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Context().Value("user").(*CustomClaims).Role != "admin" {
			http.Error(w, "Forbidden: 权限不足", 403)
			return
		}
		next.ServeHTTP(w, r)
	}
}

// ==========================================
// 4. API 业务处理函数
// ==========================================

func LoginHandler(w http.ResponseWriter, r *http.Request) {
	var req struct{ Username, Password string }
	json.NewDecoder(r.Body).Decode(&req)
	var user User
	if err := db.Where("username = ?", req.Username).First(&user).Error; err != nil {
		http.Error(w, "用户不存在", 401)
		return
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.Password), []byte(req.Password)); err != nil {
		http.Error(w, "密码错误", 401)
		return
	}
	tokenString, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, &CustomClaims{
		Username: user.Username, Team: user.Team, Role: user.Role,
		RegisteredClaims: jwt.RegisteredClaims{ExpiresAt: jwt.NewNumericDate(time.Now().Add(24 * time.Hour))},
	}).SignedString(jwtKey)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"token": tokenString, "role": user.Role, "team": user.Team, "username": user.Username})
}

func AssetCRUDHandler(w http.ResponseWriter, r *http.Request) {
	user := r.Context().Value("user").(*CustomClaims)
	w.Header().Set("Content-Type", "application/json")
	switch r.Method {
	case "GET":
		var assets []Asset
		q := db.Model(&Asset{})
		if user.Role != "admin" {
			q = q.Where("team = ?", user.Team)
		}
		q.Find(&assets)
		json.NewEncoder(w).Encode(assets)
	case "POST":
		var a Asset
		json.NewDecoder(r.Body).Decode(&a)
		if user.Role != "admin" {
			a.Team = user.Team
		}
		if a.ID == 0 {
			db.Create(&a)
		} else {
			db.Save(&a)
		}
		w.WriteHeader(http.StatusOK)
	case "DELETE":
		id, _ := strconv.Atoi(r.URL.Query().Get("id"))
		db.Delete(&Asset{}, id)
		w.WriteHeader(http.StatusOK)
	}
}

func HistoryAssetHandler(w http.ResponseWriter, r *http.Request) {
	user := r.Context().Value("user").(*CustomClaims)
	var assets []Asset
	q := db.Unscoped().Where("deleted_at IS NOT NULL")
	if user.Role != "admin" {
		q = q.Where("team = ?", user.Team)
	}
	q.Find(&assets)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(assets)
}

func ImportAssetHandler(w http.ResponseWriter, r *http.Request) {
	user := r.Context().Value("user").(*CustomClaims)
	r.ParseMultipartForm(10 << 20)
	file, _, err := r.FormFile("file")
	if err != nil {
		http.Error(w, "文件读取失败", 400)
		return
	}
	defer file.Close()

	records, err := csv.NewReader(file).ReadAll()
	if err != nil || len(records) < 2 {
		http.Error(w, "格式错误", 400)
		return
	}

	var assets []Asset
	for _, row := range records[1:] {
		if len(row) < 12 {
			continue
		}
		team := row[8]
		if user.Role != "admin" {
			team = user.Team
		}
		assets = append(assets, Asset{
			Name: row[0], Type: row[1], IPAddress: row[2], URLPath: row[3], Port: row[4],
			IsPublic: row[5] == "是", Environment: row[6], DataLevel: row[7], Team: team,
			Project: row[9], Purpose: row[10], Admin: row[11], Status: "运行中",
		})
	}
	if len(assets) > 0 {
		db.Create(&assets)
	}
	w.WriteHeader(http.StatusOK)
}

func DashboardHandler(w http.ResponseWriter, r *http.Request) {
	user := r.Context().Value("user").(*CustomClaims)
	var assets []Asset
	q := db.Model(&Asset{})
	if user.Role != "admin" {
		q = q.Where("team = ?", user.Team)
	}
	q.Find(&assets)

	teamCount := make(map[string]int)
	typeCount := make(map[string]int)
	trendCount := make(map[string]int)
	publicCount := 0

	for _, a := range assets {
		teamCount[a.Team]++
		typeCount[a.Type]++
		if a.IsPublic {
			publicCount++
		}
		trendCount[a.UpdatedAt.Format("2006-01-02")]++
	}

	var teamPie []map[string]interface{}
	for k, v := range teamCount {
		teamPie = append(teamPie, map[string]interface{}{"name": k, "value": v})
	}
	var typeKeys []string
	var typeVals []int
	for k, v := range typeCount {
		typeKeys = append(typeKeys, k)
		typeVals = append(typeVals, v)
	}
	var trendDates []string
	var trendVals []int
	for i := 6; i >= 0; i-- {
		d := time.Now().AddDate(0, 0, -i).Format("2006-01-02")
		trendDates = append(trendDates, d)
		trendVals = append(trendVals, trendCount[d])
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"total": len(assets), "public": publicCount,
		"team_pie": teamPie, "type_bar_keys": typeKeys, "type_bar_vals": typeVals,
		"trend_line_dates": trendDates, "trend_line_vals": trendVals,
	})
}

func ExportHandler(w http.ResponseWriter, r *http.Request) {
	user := r.Context().Value("user").(*CustomClaims)
	isHistory := r.URL.Query().Get("history") == "1"
	w.Header().Set("Content-Type", "text/csv")
	w.Header().Set("Content-Disposition", "attachment;filename=export.csv")
	w.Write([]byte{0xEF, 0xBB, 0xBF})
	writer := csv.NewWriter(w)
	defer writer.Flush()
	writer.Write([]string{"资产名称", "资产类型", "IP地址", "URL路径", "端口", "公网暴露", "环境", "数据敏感级", "归属团队", "项目", "用途", "负责人", "状态", "时间"})

	var assets []Asset
	q := db.Model(&Asset{})
	if isHistory {
		q = db.Unscoped().Where("deleted_at IS NOT NULL")
	}
	if user.Role != "admin" {
		q = q.Where("team = ?", user.Team)
	}
	q.Find(&assets)

	for _, a := range assets {
		isPub := "否"
		if a.IsPublic {
			isPub = "是"
		}
		writer.Write([]string{a.Name, a.Type, a.IPAddress, a.URLPath, a.Port, isPub, a.Environment, a.DataLevel, a.Team, a.Project, a.Purpose, a.Admin, a.Status, a.UpdatedAt.Format("2006-01-02")})
	}
}

func AnnouncementHandler(w http.ResponseWriter, r *http.Request) {
	user := r.Context().Value("user").(*CustomClaims)
	w.Header().Set("Content-Type", "application/json")
	switch r.Method {
	case "GET":
		var all, result []Announcement
		db.Order("created_at desc").Find(&all)
		for _, a := range all {
			if user.Role == "admin" || a.Targets == "ALL" || strings.Contains(","+a.Targets+",", ","+user.Username+",") {
				result = append(result, a)
			}
		}
		json.NewEncoder(w).Encode(result)
	case "POST":
		if user.Role != "admin" {
			http.Error(w, "Forbidden", 403)
			return
		}
		var a Announcement
		json.NewDecoder(r.Body).Decode(&a)
		a.Sender = user.Username
		if a.Targets == "" {
			a.Targets = "ALL"
		}
		db.Create(&a)
		w.WriteHeader(http.StatusOK)
	}
}

func TeamCRUDHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	switch r.Method {
	case "GET":
		var t []Team
		db.Find(&t)
		json.NewEncoder(w).Encode(t)
	case "POST":
		var t Team
		json.NewDecoder(r.Body).Decode(&t)
		if t.ID == 0 {
			db.Create(&t)
		} else {
			db.Save(&t)
		}
		w.WriteHeader(http.StatusOK)
	case "DELETE":
		id, _ := strconv.Atoi(r.URL.Query().Get("id"))
		db.Delete(&Team{}, id)
		w.WriteHeader(http.StatusOK)
	}
}

func UserCRUDHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	switch r.Method {
	case "GET":
		var u []User
		db.Select("id, username, team, role").Find(&u)
		json.NewEncoder(w).Encode(u)
	case "POST":
		var u User
		json.NewDecoder(r.Body).Decode(&u)
		if u.Password != "" {
			h, _ := bcrypt.GenerateFromPassword([]byte(u.Password), bcrypt.DefaultCost)
			u.Password = string(h)
		} else if u.ID != 0 {
			var e User
			db.First(&e, u.ID)
			u.Password = e.Password
		}
		if u.ID == 0 {
			db.Create(&u)
		} else {
			db.Save(&u)
		}
		w.WriteHeader(http.StatusOK)
	case "DELETE":
		id, _ := strconv.Atoi(r.URL.Query().Get("id"))
		db.Delete(&User{}, id)
		w.WriteHeader(http.StatusOK)
	}
}

// ==========================================
// 5. 主函数：启动与参数解析
// ==========================================
func main() {
	// 定义启动参数
	host := flag.String("h", "0.0.0.0", "监听IP地址")
	port := flag.String("p", "8080", "监听端口")
	flag.Parse()

	initDB()

	staticFS, err := fs.Sub(staticFiles, "static")
	if err != nil {
		log.Fatal("资源文件加载失败:", err)
	}

	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(staticFS)))
	mux.HandleFunc("/api/login", LoginHandler)
	mux.HandleFunc("/api/assets", AuthMiddleware(AssetCRUDHandler))
	mux.HandleFunc("/api/assets/history", AuthMiddleware(HistoryAssetHandler))
	mux.HandleFunc("/api/assets/import", AuthMiddleware(ImportAssetHandler))
	mux.HandleFunc("/api/dashboard", AuthMiddleware(DashboardHandler))
	mux.HandleFunc("/api/export", AuthMiddleware(ExportHandler))
	mux.HandleFunc("/api/announcements", AuthMiddleware(AnnouncementHandler))
	mux.HandleFunc("/api/teams", AuthMiddleware(AdminOnly(TeamCRUDHandler)))
	mux.HandleFunc("/api/users", AuthMiddleware(AdminOnly(UserCRUDHandler)))

	addr := fmt.Sprintf("%s:%s", *host, *port)
	fmt.Printf("\n🛡️灵析 资产管理系统\n")
	fmt.Printf("🌐访问地址: http://%s\n", addr)
	fmt.Printf("🔑默认管理员: admin / 123456\n\n")

	log.Fatal(http.ListenAndServe(addr, mux))
}