// ==========================================
// 全局状态管理
// ==========================================
let token = localStorage.getItem('sec_token');
let userRole = localStorage.getItem('sec_role');
let userTeam = localStorage.getItem('sec_team');
let username = localStorage.getItem('sec_username');
let teamOptions = []; 
let currentAssets = []; 
let sortCol = ''; 
let sortAsc = true; 
let charts = { pie: null, bar: null, line: null };

document.addEventListener('DOMContentLoaded', () => { if (token) showApp(); });
window.addEventListener('resize', () => { Object.values(charts).forEach(c => c && c.resize()); });

// ==========================================
// 网络拦截与鉴权
// ==========================================
async function fetchAuth(url, options = {}) {
    if (!options.headers && !(options.body instanceof FormData)) options.headers = {};
    if (!(options.body instanceof FormData)) options.headers['Content-Type'] = 'application/json';
    if (options.headers) options.headers['Authorization'] = `Bearer ${token}`;
    else options.headers = {'Authorization': `Bearer ${token}`};
    
    const res = await fetch(url, options);
    if (res.status === 401) { alert("登录态失效，请重新登录！"); logout(); throw new Error("401"); }
    if (res.status === 403) { alert("🛡️ 越权拦截：您的账号无权执行该操作！"); throw new Error("403"); }
    return res;
}

async function login() {
    const u = document.getElementById('username').value, p = document.getElementById('password').value;
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
    if (res.ok) {
        const data = await res.json();
        localStorage.setItem('sec_token', data.token); localStorage.setItem('sec_role', data.role);
        localStorage.setItem('sec_team', data.team); localStorage.setItem('sec_username', data.username);
        token = data.token; userRole = data.role; userTeam = data.team; username = data.username;
        showApp();
    } else { document.getElementById('login-error').style.display = 'block'; }
}

function logout() { localStorage.clear(); location.reload(); }

// ==========================================
// 菜单路由与视图控制
// ==========================================
function showApp() {
    document.getElementById('login-view').style.display = 'none';
    document.getElementById('app-view').style.display = 'flex';
    const nav = document.getElementById('sidebar-nav'); 
    nav.innerHTML = ''; 
    
    // 基础功能菜单
    nav.innerHTML += `<li id="menu-asset" onclick="switchTab('asset')"><span class="icon">📊</span>现网资产台账</li>`;
    nav.innerHTML += `<li id="menu-history" onclick="switchTab('history')"><span class="icon">📜</span>退役资产归档</li>`;
    nav.innerHTML += `<li id="menu-announcement" onclick="switchTab('announcement')"><span class="icon">📢</span>安全运营公告</li>`;
    
    // 物理隔离 UI
    if (userRole === 'admin') {
        document.getElementById('sys-subtitle').innerText = '全局管理控制台';
        document.getElementById('user-info').innerHTML = `<span class="badge" style="background: #ff4d4f; color: white; border:none; margin-right: 8px;">系统管理员</span> ${username}`;
        
        nav.innerHTML += `<div style="padding: 16px 24px 8px; font-size: 12px; color: #5c6b77;">系统设置</div>`;
        nav.innerHTML += `<li id="menu-team" onclick="switchTab('team')"><span class="icon">🏢</span>团队管理</li>`;
        nav.innerHTML += `<li id="menu-user" onclick="switchTab('user')"><span class="icon">👥</span>账号权限</li>`;
        document.getElementById('btnPublishAnn').style.display = 'inline-block'; 
        
        fetchTeamsForSelect();
    } else {
        document.getElementById('sys-subtitle').innerText = `[${userTeam}] 工作空间`;
        document.getElementById('user-info').innerHTML = `<span class="badge badge-ip" style="margin-right: 8px;">团队操作员</span> ${username}`;
        teamOptions = [{name: userTeam}]; 
        renderTeamSelects();
    }
    switchTab('asset');
}

function switchTab(tab) {
    document.querySelectorAll('.nav li').forEach(el => el.classList.remove('active'));
    const targetMenu = document.getElementById(`menu-${tab}`); 
    if (!targetMenu) return; // 拦截防误触
    targetMenu.classList.add('active');
    
    ['asset', 'history', 'announcement', 'team', 'user'].forEach(t => document.getElementById(`view-${t}`).style.display = 'none');
    document.getElementById(`view-${tab}`).style.display = 'block';
    
    if(tab === 'asset') { document.getElementById('pageTitle').innerText = "资产安全态势大屏"; loadDashboard(); loadAssets(); }
    if(tab === 'history') { document.getElementById('pageTitle').innerText = "历史资产溯源库"; loadHistoryAssets(); }
    if(tab === 'announcement') { document.getElementById('pageTitle').innerText = "安全系统消息通知"; loadAnnouncements(); }
    if(tab === 'team') { document.getElementById('pageTitle').innerText = "安全团队组织管理"; loadTeams(); }
    if(tab === 'user') { document.getElementById('pageTitle').innerText = "系统账号与权限分配"; loadUsers(); }
}

function closeModal(id) { document.getElementById(id).style.display = 'none'; }

// ==========================================
// 业务逻辑 1: 系统公告 (新增)
// ==========================================
async function loadAnnouncements() {
    const data = await (await fetchAuth('/api/announcements')).json() || [];
    const container = document.getElementById('announcementList');
    container.innerHTML = '';
    if (data.length === 0) { container.innerHTML = '<p style="color:#999; text-align:center;">暂无任何系统消息</p>'; return; }
    
    data.forEach(a => {
        const targetLabel = a.targets === "ALL" ? `<span class="badge badge-url">全员广播</span>` : `<span class="badge badge-ip">定向推送给您</span>`;
        container.innerHTML += `
        <div class="ann-card">
            <div class="ann-header">
                <div class="ann-title">📌 ${a.title} ${targetLabel}</div>
                <div class="ann-meta">发件人：${a.sender} | 时间：${new Date(a.created_at).toLocaleString()}</div>
            </div>
            <div class="ann-content">${a.content}</div>
        </div>`;
    });
}

async function openAnnounceModal() {
    document.getElementById('announceModal').style.display = 'block';
    document.getElementById('annTitle').value = '';
    document.getElementById('annContent').value = '';
    
    const users = await (await fetchAuth('/api/users')).json() || [];
    const box = document.getElementById('annTargetBox');
    box.innerHTML = '';
    users.forEach(u => {
        box.innerHTML += `<label class="target-item"><input type="checkbox" name="annTargetsCheck" value="${u.username}"> ${u.username} (${u.team})</label>`;
    });
}

async function saveAnnouncement() {
    const title = document.getElementById('annTitle').value;
    const content = document.getElementById('annContent').value;
    if (!title || !content) return alert("标题和内容为必填项！");
    
    let targetsArray = [];
    document.querySelectorAll('input[name="annTargetsCheck"]:checked').forEach(cb => targetsArray.push(cb.value));
    const targetsStr = targetsArray.length > 0 ? targetsArray.join(',') : "ALL";
    
    await fetchAuth('/api/announcements', {
        method: 'POST',
        body: JSON.stringify({ title: title, content: content, targets: targetsStr })
    });
    
    closeModal('announceModal');
    loadAnnouncements();
}

// ==========================================
// 业务逻辑 2: 资产态势大屏图表
// ==========================================
async function loadDashboard() {
    const data = await (await fetchAuth('/api/dashboard')).json();
    document.getElementById('totalAsset').innerText = data.total; 
    document.getElementById('publicAsset').innerText = data.public;
    
    if(!charts.pie) charts.pie = echarts.init(document.getElementById('teamPieChart')); 
    charts.pie.setOption({ title: { text: '资产按团队分布', left: 'center', textStyle: { fontSize: 14 } }, tooltip: { trigger: 'item' }, series: [{ type: 'pie', radius: '60%', data: data.team_pie, itemStyle: { borderRadius: 4, borderColor: '#fff', borderWidth: 2 } }] });
    
    if(!charts.bar) charts.bar = echarts.init(document.getElementById('typeBarChart')); 
    charts.bar.setOption({ title: { text: '资产按类型统计', left: 'center', textStyle: { fontSize: 14 } }, tooltip: { trigger: 'axis' }, xAxis: { type: 'category', data: data.type_bar_keys }, yAxis: { type: 'value' }, series: [{ type: 'bar', data: data.type_bar_vals, itemStyle: { color: '#1677ff' }, barWidth: '40%' }] });
    
    if(!charts.line) charts.line = echarts.init(document.getElementById('trendLineChart')); 
    charts.line.setOption({ title: { text: '最近7日资产变更趋势', left: 'center', textStyle: { fontSize: 14 } }, tooltip: { trigger: 'axis' }, xAxis: { type: 'category', data: data.trend_line_dates }, yAxis: { type: 'value' }, series: [{ type: 'line', data: data.trend_line_vals, smooth: true, areaStyle: {}, itemStyle: { color: '#52c41a' } }] });
}

// ==========================================
// 业务逻辑 3: 资产管理与联动
// ==========================================
async function loadAssets() { currentAssets = await (await fetchAuth('/api/assets')).json() || []; renderAssetsTable(); }
async function loadHistoryAssets() {
    const data = await (await fetchAuth('/api/assets/history')).json() || [];
    const tbody = document.getElementById('historyTbody'); 
    tbody.innerHTML = '';
    data.forEach(a => {
        let net = a.type === 'IP' ? a.ip_address : a.url_path;
        tbody.innerHTML += `<tr><td style="color:#8c8c8c">${new Date(a.deleted_at).toLocaleString()}</td><td><strong>${a.name}</strong></td><td><span class="badge ${a.type==='IP'?'badge-ip':'badge-url'}">${a.type}</span></td><td style="font-family: monospace;">${net||'-'}</td><td>${a.port||'-'}</td><td>${a.team}</td><td>${a.admin}</td><td><span class="status-dot bg-disabled"></span>已封存归档</td></tr>`;
    });
}

function doSort(field) {
    if (sortCol === field) sortAsc = !sortAsc; else { sortCol = field; sortAsc = true; }
    currentAssets.sort((a, b) => { let valA = String(a[field] || '').toLowerCase(); let valB = String(b[field] || '').toLowerCase(); if (valA < valB) return sortAsc ? -1 : 1; if (valA > valB) return sortAsc ? 1 : -1; return 0; });
    renderAssetsTable();
}

function renderAssetsTable() {
    const tbody = document.getElementById('assetTbody'); 
    tbody.innerHTML = '';
    currentAssets.forEach(a => {
        let net = a.type === 'IP' ? a.ip_address : a.url_path;
        tbody.innerHTML += `<tr><td><strong>${a.name}</strong></td><td><span class="badge ${a.type==='IP'?'badge-ip':'badge-url'}">${a.type}</span></td><td style="font-family: monospace; color: var(--primary-color)">${net||'-'}</td><td style="font-family: monospace; color: #5c6b77">${a.port||'-'}</td><td>${a.environment}</td><td>${a.is_public ? `<span class="text-danger">⚠ 是</span>` : `否`}</td><td>${a.data_level}</td><td>${a.team}</td><td><button class="btn btn-text text-primary" onclick='editAsset(${JSON.stringify(a)})'>配置</button> <button class="btn btn-text text-danger" onclick="triggerOffline(${a.id}, '${a.name}')">下线</button></td></tr>`;
    });
}

function toggleNetworkFields() {
    const type = document.getElementById('assetType').value;
    if (type === 'IP') { document.getElementById('urlInputGroup').style.display = 'none'; document.getElementById('assetURL').value = ''; document.getElementById('assetIP').placeholder = "如: 192.168.1.1"; } 
    else { document.getElementById('urlInputGroup').style.display = 'block'; document.getElementById('assetIP').placeholder = "选填: 解析IP"; }
}

function openAssetModal() {
    document.getElementById('assetModal').style.display = 'block'; document.getElementById('assetModalTitle').innerText = "新增资产登记";
    ['assetId','assetName','assetProject','assetPurpose','assetIP','assetPort','assetURL'].forEach(id => document.getElementById(id).value = '');
    document.getElementById('assetPublic').value = "false"; document.getElementById('assetType').value = "IP";
    document.getElementById('assetTeam').disabled = (userRole !== 'admin');
    if (userRole !== 'admin') document.getElementById('assetTeam').value = userTeam;
    toggleNetworkFields();
}

function editAsset(a) {
    openAssetModal(); document.getElementById('assetModalTitle').innerText = "资产配置更新";
    document.getElementById('assetId').value = a.id; document.getElementById('assetName').value = a.name; document.getElementById('assetType').value = a.type; document.getElementById('assetEnv').value = a.environment; document.getElementById('assetIP').value = a.ip_address; document.getElementById('assetPort').value = a.port; document.getElementById('assetURL').value = a.url_path; document.getElementById('assetPublic').value = a.is_public.toString(); document.getElementById('assetData').value = a.data_level; document.getElementById('assetProject').value = a.project; document.getElementById('assetPurpose').value = a.purpose; document.getElementById('assetTeam').value = a.team;
    toggleNetworkFields();
}

async function saveAsset() {
    if (!document.getElementById('assetName').value) return alert("资产名称为必填项");
    const payload = { id: parseInt(document.getElementById('assetId').value) || 0, name: document.getElementById('assetName').value, type: document.getElementById('assetType').value, ip_address: document.getElementById('assetIP').value, port: document.getElementById('assetPort').value, url_path: document.getElementById('assetURL').value, environment: document.getElementById('assetEnv').value, is_public: document.getElementById('assetPublic').value === 'true', data_level: document.getElementById('assetData').value, project: document.getElementById('assetProject').value, purpose: document.getElementById('assetPurpose').value, team: document.getElementById('assetTeam').value };
    await fetchAuth('/api/assets', { method: 'POST', body: JSON.stringify(payload) });
    closeModal('assetModal'); loadDashboard(); loadAssets();
}

function triggerOffline(id, name) {
    document.getElementById('offlineConfirmModal').style.display = 'block';
    document.getElementById('offlineAssetName').innerText = name;
    document.getElementById('offlineAssetId').value = id;
}
async function confirmDeleteAsset() {
    await fetchAuth(`/api/assets?id=${document.getElementById('offlineAssetId').value}`, { method: 'DELETE' });
    closeModal('offlineConfirmModal'); loadDashboard(); loadAssets();
}

// 导入与导出
async function uploadCSV() {
    const file = document.getElementById('importFile').files[0];
    if(!file) return;
    const formData = new FormData(); formData.append("file", file);
    try { await fetchAuth('/api/assets/import', { method: 'POST', body: formData }); alert("导入成功！"); loadDashboard(); loadAssets(); } 
    catch(e) { alert("导入失败！请检查表头是否符合模板要求。"); }
    document.getElementById('importFile').value = ''; 
}

async function exportCSV(isHistory) {
    const res = await fetchAuth(`/api/export?history=${isHistory}`); 
    const blob = await res.blob();
    const url = window.URL.createObjectURL(blob); 
    const a = document.createElement('a'); a.href = url;
    a.download = isHistory ? `历史归档快照_${new Date().toISOString().slice(0, 10)}.csv` : `现网资产快照_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); window.URL.revokeObjectURL(url);
}

// ==========================================
// 业务逻辑 4: 基础权限管理
// ==========================================
async function fetchTeamsForSelect() { teamOptions = await (await fetchAuth('/api/teams')).json() || []; renderTeamSelects(); }
function renderTeamSelects() { document.getElementById('assetTeam').innerHTML = teamOptions.map(t => `<option value="${t.name}">${t.name}</option>`).join(''); document.getElementById('userTeam').innerHTML = teamOptions.map(t => `<option value="${t.name}">${t.name}</option>`).join(''); }

async function loadTeams() {
    const data = await (await fetchAuth('/api/teams')).json() || [];
    const tbody = document.getElementById('teamTbody'); tbody.innerHTML = '';
    data.forEach(t => { tbody.innerHTML += `<tr><td>${t.id}</td><td><strong>${t.name}</strong></td><td>${t.desc}</td><td><button class="btn btn-text text-primary" onclick='editTeam(${JSON.stringify(t)})'>编辑</button> <button class="btn btn-text text-danger" onclick="deleteTeam(${t.id})">解散</button></td></tr>`; });
}
function openTeamModal() { document.getElementById('teamModal').style.display='block'; document.getElementById('teamId').value=''; document.getElementById('teamName').value=''; document.getElementById('teamDesc').value=''; }
function editTeam(t) { openTeamModal(); document.getElementById('teamId').value=t.id; document.getElementById('teamName').value=t.name; document.getElementById('teamDesc').value=t.desc; }
async function saveTeam() { await fetchAuth('/api/teams', { method: 'POST', body: JSON.stringify({id: parseInt(document.getElementById('teamId').value)||0, name: document.getElementById('teamName').value, desc: document.getElementById('teamDesc').value}) }); closeModal('teamModal'); loadTeams(); fetchTeamsForSelect(); }
async function deleteTeam(id) { if(confirm("解散该团队会导致相关资产变为无主资产，确定继续？")) { await fetchAuth(`/api/teams?id=${id}`, {method:'DELETE'}); loadTeams(); fetchTeamsForSelect(); } }

async function loadUsers() {
    const data = await (await fetchAuth('/api/users')).json() || [];
    const tbody = document.getElementById('userTbody'); tbody.innerHTML = '';
    data.forEach(u => { tbody.innerHTML += `<tr><td>${u.id}</td><td><strong>${u.username}</strong></td><td>${u.team}</td><td>${u.role==='admin'?'全局管理':'普通用户'}</td><td><button class="btn btn-text text-primary" onclick='editUser(${JSON.stringify(u)})'>编辑</button> <button class="btn btn-text text-danger" onclick="deleteUser(${u.id})">注销</button></td></tr>`; });
}
function openUserModal() { document.getElementById('userModal').style.display='block'; document.getElementById('userId').value=''; document.getElementById('userAccount').value=''; document.getElementById('userPwd').value=''; }
function editUser(u) { openUserModal(); document.getElementById('userId').value=u.id; document.getElementById('userAccount').value=u.username; document.getElementById('userRole').value=u.role; document.getElementById('userTeam').value=u.team; document.getElementById('userPwd').value=''; }
async function saveUser() { await fetchAuth('/api/users', { method: 'POST', body: JSON.stringify({id: parseInt(document.getElementById('userId').value)||0, username: document.getElementById('userAccount').value, password: document.getElementById('userPwd').value, role: document.getElementById('userRole').value, team: document.getElementById('userTeam').value}) }); closeModal('userModal'); loadUsers(); }
async function deleteUser(id) { if(confirm("确定注销该账号？")) { await fetchAuth(`/api/users?id=${id}`, {method:'DELETE'}); loadUsers(); } }
// ==========================================
// 🚀 科技风登录页粒子连线动画 (原生 Canvas)
// ==========================================
function initTechAnimation() {
    const canvas = document.getElementById('techCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let width, height, particles;

    // 自适应屏幕大小
    function init() {
        width = canvas.width = window.innerWidth;
        height = canvas.height = window.innerHeight;
        particles = [];
        // 根据屏幕大小动态决定粒子密度
        const particleCount = Math.floor((width * height) / 12000); 
        for (let i = 0; i < particleCount; i++) {
            particles.push(new Particle());
        }
    }

    class Particle {
        constructor() {
            this.x = Math.random() * width;
            this.y = Math.random() * height;
            // 粒子游走速度
            this.vx = (Math.random() - 0.5) * 0.8; 
            this.vy = (Math.random() - 0.5) * 0.8;
            this.radius = Math.random() * 1.5 + 0.5; // 节点大小
        }
        update() {
            this.x += this.vx;
            this.y += this.vy;
            // 边缘反弹
            if (this.x < 0 || this.x > width) this.vx = -this.vx;
            if (this.y < 0 || this.y > height) this.vy = -this.vy;
        }
        draw() {
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(22, 119, 255, 0.8)'; // 主题科技蓝
            ctx.fill();
        }
    }

    function animate() {
        ctx.clearRect(0, 0, width, height);
        
        for (let i = 0; i < particles.length; i++) {
            particles[i].update();
            particles[i].draw();
            
            // 检测距离，绘制连线
            for (let j = i + 1; j < particles.length; j++) {
                const dx = particles[i].x - particles[j].x;
                const dy = particles[i].y - particles[j].y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                
                // 距离小于 120 像素时连线
                if (dist < 120) {
                    ctx.beginPath();
                    // 距离越近，线条越不透明
                    ctx.strokeStyle = `rgba(22, 119, 255, ${1 - dist / 120})`;
                    ctx.lineWidth = 0.6;
                    ctx.moveTo(particles[i].x, particles[i].y);
                    ctx.lineTo(particles[j].x, particles[j].y);
                    ctx.stroke();
                }
            }
        }
        
        // 只有在登录页显示时才继续执行动画，节省性能
        if (document.getElementById('login-view').style.display !== 'none') {
            requestAnimationFrame(animate);
        }
    }

    init();
    animate();
    
    // 监听窗口缩放防变形
    window.addEventListener('resize', init);
}

// 确保 DOM 加载完毕后启动动画
document.addEventListener('DOMContentLoaded', initTechAnimation);