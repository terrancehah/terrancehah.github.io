/* biwa-i18n.js — English/中文 display layer for the ride companion.
 *
 * The English source text IS the dictionary key — call sites stay readable
 * and English needs no table at all. Chinese entries live in ZH, keyed by
 * the exact English literal; interpolated strings use {name} placeholders
 * because word order differs between the languages. Data text (place
 * names, day labels) never lives in the shared trip snapshot — it is
 * translated at display time only, keyed by stable placeId/dayId, so
 * user-authored labels and pins always keep their own text. The choice
 * persists in localStorage, never in the shared trip.
 */
(function (global) {
	"use strict";

	var I18n = {};
	var STORAGE_KEY = "biwa-lang";
	var lang = "en";

	// --- UI strings: English literal -> 简体中文 ------------------------------------
	var ZH = {
		// Shell / navigation
		"Lake Biwa Ride": "琵琶湖骑行",
		"Lake Biwa Ride Companion": "琵琶湖骑行助手",
		"Otsu - Hikone - Takashima - Otsu": "大津 - 彦根 - 高岛 - 大津",
		Timeline: "行程",
		Map: "地图",
		Nearby: "附近",
		Views: "视图",
		"Choose riding day": "选择骑行日",
		"Map layers": "地图图层",
		Footer: "页脚",
		Projects: "项目",
		"Made with": "由",
		" by Terrance": "Terrance 用心制作",
		"Close place details": "关闭地点详情",
		"Switch to Chinese": "切换到中文",
		"Switch to English": "Switch to English",

		// Up-next card / shared actions
		"Up Next": "下一站",
		"Ride Complete": "行程完成",
		"Three days around Lake Biwa — every planned stop completed.":
			"环琵琶湖三日骑行——所有计划站点均已完成。",
		"{day} Complete": "{day}完成",
		"Day 3 complete. You’re back in Otsu.": "第3天完成。你已回到大津。",
		"Every stop visited. Time to rest and recharge.":
			"所有站点均已到访。好好休息，恢复体力吧。",
		"Your itinerary": "你的行程",
		"No stops planned for this day yet": "当天还没有安排站点",
		"Finish your day plan": "完善当日计划",
		"Set the missing start or finish point to complete this day.":
			"请补上缺少的起点或终点，以完成当日计划。",
		Directions: "导航",
		"Mark as Completed": "标记为已完成",
		Done: "完成",
		// Mini-bar check-in lifecycle (label, aria and phase text)
		"Navigate to {name}": "导航前往{name}",
		"Check in": "打卡",
		"Check in at {name}": "在{name}打卡",
		"Checking in at {name}": "正在{name}打卡",
		"Saving…": "保存中…",
		"Checked in at {name}": "已在{name}打卡",
		Completed: "已完成",
		"Official Certificate Check-In": "官方证书打卡",
		"Check In on Official Site": "前往官网打卡",
		"Rally Check-In": "集章打卡",
		"Check In on Rally Site": "前往集章官网打卡",

		// Certificate progress strip
		"rally stops": "集章站点",
		"official areas": "官方区域",
		"of {total} {label}": "/ {total} {label}",
		"Both certificate checklists completed": "两份证书打卡清单已全部完成",
		"All three riding days completed": "三天骑行已全部完成",

		// Timeline track
		"Road distances are a preview from ": "道路距离预览来自 ",
		" — not cycling guidance. Times estimate 15 km/h riding, breaks excluded.":
			"——并非骑行导航。时间按 15 km/h 骑行估算，不含休息。",
		"Estimated at 15 km/h, excluding breaks.":
			"按 15 km/h 估算，不含休息。",
		"{n} m road": "{n} 米（道路）",
		"{n} km road": "{n} 公里（道路）",
		"Calculating road distance…": "正在计算道路距离…",
		"Road distance unavailable": "道路距离不可用",
		"≈ {n} min cycling": "≈ {n} 分钟骑行",
		"≈ {h} h {m} min cycling": "≈ {h} 小时 {m} 分钟骑行",
		"≈ {h} h cycling": "≈ {h} 小时骑行",
		"No stops yet — add one below.": "还没有站点——可在下方添加。",
		"Start point not set": "未设置起点",
		"Overnight point not set": "未设置住宿点",
		"Finish point not set": "未设置终点",
		Set: "设置",
		"Pinned point": "自定义标点",
		"Start here": "从这里出发",
		"Leave after the night": "住一晚后出发",
		"Finish — return the bikes": "终点——归还自行车",
		"Overnight stay": "过夜住宿",
		S: "起",
		E: "终",
		"Additional attraction": "附加景点",
		"(name unconfirmed)": "（名称未确认）",
		"name unconfirmed": "名称未确认",
		"Mark visited: {name}": "标记已到访：{name}",
		"Mark not visited: {name}": "取消到访标记：{name}",
		"{name} — details": "{name}——详情",
		"{name} — details. Press Alt+Up or Alt+Down to reorder.":
			"{name}——详情。按 Alt+↑ 或 Alt+↓ 可调整顺序。",
		"Reorder {name} by dragging": "拖动以调整{name}的顺序",
		"Checked in": "已打卡",
		"Checked in — {name}": "已打卡——{name}",
		Stay: "住宿",
		"Bike-friendly parking — group curated": "自行车友好停车点——小队精选",
		"Bike-friendly — group curated": "自行车友好——小队精选",

		// Destination sheet
		"On the plan: {list}": "已列入计划：{list}",
		"Get Directions": "获取路线",
		"Rating {r}": "评分 {r}",
		" · {n} review": " · {n} 条评价",
		" · {n} reviews": " · {n} 条评价",
		"Rating not provided": "暂无评分",
		"Photos of {name}": "{name}的照片",
		"Photo of {name}": "{name}的照片",
		"Photo unavailable.": "照片无法加载。",
		"No photos provided for this place.": "该地点暂无照片。",
		"Photos © {names} via ": "照片 © {names} 来自 ",
		"Photo © {names}": "照片 © {names}",
		"Google contributors": "Google 供图者",
		"Details via ": "详情来自 ",
		Address: "地址",
		"Opening hours and photos are not configured on this app — Get Directions opens Google Maps with the latest details.":
			"本应用未配置营业时间与照片——“获取路线”可在 Google 地图查看最新详情。",
		"Loading details…": "正在加载详情…",
		"Details unavailable for this place — Get Directions opens Google Maps with the latest info.":
			"无法获取该地点详情——“获取路线”可在 Google 地图查看最新信息。",
		"Open now": "正在营业",
		"Closed now": "已打烊",
		"Opening hours": "营业时间",
		"Opening hours not provided for this place.":
			"该地点暂无营业时间信息。",
		Website: "官方网站",
		"Third-party provider": "第三方数据方",
		"Previous photo": "上一张照片",
		"Next photo": "下一张照片",

		// Dialogs
		"Add stop to {day}": "添加站点至{day}",
		Place: "地点",
		"The full catalogue is listed — official checkpoints you add appear in the itinerary without affecting stamp progress until ticked.":
			"已列出全部目录地点——添加的官方打卡点会进入行程，但在勾选前不影响盖章进度。",
		"New custom place": "新增自定义地点",
		"Edit {name}": "编辑{name}",
		Name: "名称",
		Kind: "类型",
		"Custom stop": "自定义站点",
		Accommodation: "住宿",
		"Bike-friendly parking (confirmed by the group)":
			"自行车友好停车点（经小队确认）",
		"Only choose parking for spots the group has actually confirmed — that label is what marks it bike-friendly.":
			"只有小队实际确认过的地点才选“停车点”——该标签是“自行车友好”的标记。",
		Latitude: "纬度",
		Longitude: "经度",
		"Google place id (optional)": "Google 地点 ID（可选）",
		"Address (optional)": "地址（可选）",
		"Enter coordinates or a Google place id or an address — at least one is needed so the place can be found.":
			"坐标、Google 地点 ID 或地址至少填写一项，才能定位该地点。",
		"Certificate checkpoint coordinates and Google ids are fixed; only the name and notes can be edited.":
			"证书打卡点的坐标与 Google ID 不可更改；只能编辑名称与备注。",
		Notes: "备注",
		"Start point": "起点",
		"Overnight point": "住宿点",
		"Choose an existing place": "选择已有地点",
		"— or enter coordinates below —": "——或在下方输入坐标——",
		"Point label": "标点名称",
		"e.g. Hotel in Hikone": "例如：彦根的酒店",
		"This also becomes the next day’s start — the group sleeps where the day ended.":
			"这也会成为次日的起点——小队在当天结束的地方过夜。",
		"Clear endpoint": "清除端点",
		Stop: "站点",
		Cancel: "取消",
		Save: "保存",
		"Someone else saved first": "有人先保存了",
		"Another phone updated the trip while you were editing. Your unsaved draft is still on this phone — you can load the shared version, or explicitly replace the whole shared trip with your snapshot (their edits would be overwritten).":
			"你编辑期间，另一台手机更新了行程。你未保存的草稿仍在本机——可以加载共享版本，或明确用你的快照覆盖整个共享行程（对方的修改将被覆盖）。",
		"Replace shared trip with mine": "用我的版本覆盖共享行程",
		"Load shared version": "加载共享版本",
		Close: "关闭",

		// Device pairing — personal trips claimed across your own devices
		"Pair devices": "配对设备",
		"Your trip and check-ins are personal to each device. To see the same trip on another of your devices, show a code here and enter it there.":
			"你的行程和打卡记录是各设备独立的。要在你的另一台设备上看到相同的行程，请在此处生成配对码，并在那台设备上输入。",
		"Send this trip to another device": "将此行程发送到另一台设备",
		"Show a code": "显示配对码",
		"Valid for 10 minutes — enter it on the other device to claim this trip.":
			"有效期 10 分钟——在另一台设备上输入即可获取此行程。",
		"This device is new": "这是新设备",
		"6-letter code": "6 位配对码",
		"Claim trip": "获取行程",
		"Requesting code…": "正在生成配对码…",
		"Could not create a code — try again.": "无法生成配对码——请重试。",
		"Claiming…": "正在获取…",
		"That code is invalid or expired — check it and try again.":
			"配对码无效或已过期——请核对后重试。",
		"Trip claimed — reloading…": "已获取行程——正在重新加载…",

		// Offline escape-hatch toasts — transient connection-transition
		// messages only; there is no offline mode or status readout. English
		// source is the key; these mirror the literals in offline-cache.js.
		"Offline — using your saved itinerary. Changes stay on this phone until the connection returns.":
			"离线状态——正在使用已保存的行程。修改会保留在此手机上，直到网络恢复。",
		"Offline — keep this page open; changes cannot be saved on this phone.":
			"离线状态——请保持此页面打开；修改无法保存在此手机上。",
		"Connection interrupted — using your saved itinerary. Changes stay on this phone until syncing resumes.":
			"连接中断——正在使用已保存的行程。修改会保留在此手机上，直到同步恢复。",
		"Connection restored — your changes are synced.":
			"连接已恢复——你的修改已同步。",

		// Map view
		"Live map needs a configured Google Maps key — the stop schematic below is drawn from your own list.":
			"实时地图需要配置 Google 地图密钥——下方示意图由你的站点列表绘制。",
		"Live map unavailable — showing your stop order only.":
			"实时地图不可用——仅显示站点顺序。",
		"(route point)": "（途经点）",
		"requesting road preview…": "正在请求道路预览…",
		"road distance unavailable": "道路距离不可用",
		"road preview blocked — enable the Routes API for the Google key":
			"道路预览被阻止——请为 Google 密钥启用 Routes API",
		"set the {err} to unlock the road preview": "设置{err}即可解锁道路预览",
		"start point not set": "起点",
		"overnight point not set": "住宿点",
		"start + overnight point not set": "起点和住宿点",
		"road preview waiting for coordinates — unroutable: ":
			"道路预览等待坐标——无法定位：",
		"road preview unavailable": "道路预览不可用",
		"road preview not requested": "道路预览未请求",
		Retry: "重试",
		"{day} route": "{day}路线",
		"Rally stops": "集章站点",
		Stays: "住宿",
		"Other stops / route points": "其他站点/途经点",
		Pending: "待完成",
		"No locations planned": "暂无安排地点",
		Start: "起点",
		Finish: "终点",
		"Map data ©": "地图数据 ©",
		"Google Maps terms": "Google 地图条款",
		"Our terms": "使用条款",
		Privacy: "隐私政策",
		"Road preview, not cycling guidance. Avoidance is a preference, not a guarantee — the line may still include restricted road features.":
			"仅为道路预览，并非骑行导航。回避选项仅为偏好而非保证——路线仍可能包含受限路段。",
		"Stop schematic — not a road route": "站点示意图——非道路路线",
		"Stop order schematic, not a road route": "站点顺序示意图，非道路路线",
		"Elevation profile unavailable": "海拔剖面不可用",

		// Nearby view
		"Find nearby": "查找附近",
		"Shortcut searches open in Google Maps around the anchor below — ordinary map listings, never labelled bike-friendly.":
			"快捷搜索会在下方锚点周边的 Google 地图中打开——均为普通地图结果，不标注自行车友好属性。",
		"Update my location": "更新我的位置",
		"Bike-friendly parking": "自行车友好停车点",
		Attractions: "景点",
		Restaurants: "餐厅",
		"Convenience stores": "便利店",
		Laundromats: "洗衣店",
		"Bike repair": "自行车维修",
		"Bike parking": "自行车停车点",
		"{cat} — group’s list": "{cat}——小队精选",
		"Near {name} · {day}": "靠近{name} · {day}",
		"Near your location": "靠近你的位置",
		"Search area: {name} · based on completed stops":
			"搜索范围：{name} · 基于已完成站点",
		"Update your location to search nearby": "更新位置以搜索附近",
		"Geolocation is not available in this browser.": "此浏览器不支持定位。",
		"Requesting location…": "正在请求位置…",
		"Location updated (accuracy ±{n} m).": "位置已更新（精度 ±{n} 米）。",
		"Could not refresh your location — keeping the last fix. Check the browser permission.":
			"无法刷新位置——保留上次定位。请检查浏览器定位权限。",
		"Location unavailable — searches use the plan anchor below. Check the browser permission and try again.":
			"无法获取位置——搜索将使用下方计划锚点。请检查浏览器定位权限后重试。",
		"Open in Maps": "在地图中打开",
		"+ Add stop": "+ 添加站点",
		"+ New custom place": "+ 新增自定义地点",
	};

	// --- Catalogue place names keyed by stable placeId -------------------------------
	// Japanese venue names that ARE the common Chinese rendering keep their
	// kanji form (simplified where the characters differ); English-only
	// records get a translated name. User-authored labels, pins and custom
	// places fall through to their own text.
	var PLACE_ZH = {
		"official-south-otsu": "大津港",
		"official-south-kusatsu": "道之驿·草津",
		"official-south-marriott": "琵琶湖万豪酒店",
		"official-south-otsuka": "琵琶湖大冢酒店",
		"official-south-shiga": "滋贺县观光协会",
		"official-east-chomei": "长命庵",
		"official-east-notogawa": "能登川水车·皮划艇乐园",
		"official-east-mitsuya": "湖岸绿地·南三谷",
		"official-east-hikone": "近江海运彦根港",
		"official-north-maibara": "米原单车驿站",
		"official-north-hahanosato": "道之驿·近江母之乡",
		"official-north-nagahama": "长滨港",
		"mizudori-station": "道之驿·湖北水鸟驿站",
		"official-north-koti": "JR永原站社区之家 koti",
		"official-west-boat": "观光船码头",
		"official-west-stagex": "STAGEX高岛",
		"official-west-information": "近江高岛旅游信息中心（近江高岛站）",
		"rally-rental": "琵琶湖自行车租赁店（ビワイチバイク）",
		"rally-mizunomori": "草津市立水生植物公园·水之森",
		"rally-mentai": "明太子乐园·琵琶湖",
		"rally-castle": "彦根城",
		"rally-dome": "长滨巨蛋体育馆",
		"rally-shiotsu": "道之驿·盐津海道 味灶之乡",
		"rally-kitahira": "北比良 1039-2",
		"rally-ogoto": "大津市雄琴温泉观光公园",
		"rally-otsukan": "琵琶湖大津馆",
		"stay-hana": "花之民宿（Guest House Hana）",
		"stay-comfort": "彦根康福特酒店",
		"stay-rinkoso": "临湖庄",
		"extra-chomeiji-183": "长命寺町 183 号",
		"extra-oura": "西浅井町大浦 1640-2",
		"extra-takashima-station": "近江高岛站",
		"extra-ukawa": "白须神社",
	};

	// Seeded day labels/titles keyed by dayId — custom day text falls through.
	var DAY_ZH = {
		"day-1": { label: "第1天", title: "大津 → 彦根" },
		"day-2": { label: "第2天", title: "彦根 → 高岛" },
		"day-3": { label: "第3天", title: "高岛 → 大津" },
	};

	// Official shore-area labels keyed by area key — used by the legend
	// toggles and the 'Official · X' badge suffix.
	var AREA_ZH = { south: "南岸", east: "东岸", north: "北岸", west: "西岸" };
	var AREA_LABEL_ZH = {
		"South shore": "南岸",
		"East shore": "东岸",
		"North shore": "北岸",
		"West shore": "西岸",
	};

	function interpolate(text, vars) {
		if (!vars) return text;
		return text.replace(/\{(\w+)\}/g, function (match, name) {
			return vars[name] !== undefined ? vars[name] : match;
		});
	}

	// English literal (optionally with {name} placeholders) -> display text.
	I18n.t = function (key, vars) {
		var text = lang === "zh" && ZH[key] ? ZH[key] : key;
		return interpolate(text, vars);
	};

	// Display name for a place or day-point ({placeId, label, ...}). The
	// shared snapshot keeps its own label; Chinese swaps the catalogue
	// names only. Unlabelled pins carry the literal default, which is
	// itself a translatable string.
	I18n.placeName = function (p) {
		if (!p) return "";
		if (lang !== "zh") return p.label || "";
		if (p.placeId && PLACE_ZH[p.placeId]) return PLACE_ZH[p.placeId];
		if (p.label === "Pinned point") return ZH["Pinned point"];
		return p.label || "";
	};

	I18n.dayLabel = function (day) {
		if (!day) return "";
		if (lang === "zh" && DAY_ZH[day.dayId]) return DAY_ZH[day.dayId].label;
		return day.label || "";
	};

	I18n.dayTitle = function (day) {
		if (!day) return "";
		if (lang === "zh" && DAY_ZH[day.dayId]) return DAY_ZH[day.dayId].title;
		return day.title || "";
	};

	// 'South shore' style area labels — accepts an OFFICIAL_AREAS entry or
	// its key.
	I18n.areaLabel = function (area) {
		if (!area) return "";
		if (lang !== "zh") return area.label || "";
		return (
			AREA_ZH[area.key] || AREA_LABEL_ZH[area.label] || area.label || ""
		);
	};

	// Programme badge text from Rules.placeBadges ('Rally', 'Official · South').
	I18n.badge = function (badge) {
		if (lang !== "zh") return badge;
		// The rally is a limited-time stamp rally, not a motorsport rally.
		if (badge === "Rally") return "限时集章";
		var m = /^Official · (.+)$/.exec(badge);
		if (m) return "官方 · " + (AREA_ZH[m[1].toLowerCase()] || m[1]);
		return badge;
	};

	// One placeBadges string can carry two facts — 'Official · South' renders
	// as two chips: a programme chip (官方) plus a shore chip (南岸) whose
	// data-area drives the map-marker colour. Non-official badges stay a
	// single chip. Each part is { text, programme, area? }.
	I18n.badgeParts = function (badge) {
		var m = /^Official · (.+)$/.exec(badge);
		if (!m) {
			return [
				{
					text: I18n.badge(badge),
					programme: badge === "Rally" ? "rally" : "official",
				},
			];
		}
		var key = m[1].toLowerCase();
		var programmeText = lang === "zh" ? "官方" : "Official";
		var shoreText = lang === "zh" ? AREA_ZH[key] || m[1] : m[1];
		return [
			{ text: programmeText, programme: "official" },
			{ text: shoreText, programme: "official", area: key },
		];
	};

	I18n.lang = function () {
		return lang;
	};

	// Apply the current language to every statically marked element:
	//   data-i18n="English"            -> textContent
	//   data-i18n-aria-label="English" -> aria-label
	//   data-i18n-title="English"      -> title
	//   data-i18n-placeholder="English"-> placeholder
	I18n.applyStatic = function (root) {
		var scope = root || document;
		scope.querySelectorAll("[data-i18n]").forEach(function (node) {
			node.textContent = I18n.t(node.getAttribute("data-i18n"));
		});
		["aria-label", "title", "placeholder"].forEach(function (attr) {
			scope
				.querySelectorAll("[data-i18n-" + attr + "]")
				.forEach(function (node) {
					node.setAttribute(
						attr,
						I18n.t(node.getAttribute("data-i18n-" + attr)),
					);
				});
		});
	};

	// Persist + apply a language across static markup, the document element
	// and the masthead switch's segment states. Dynamic views repaint
	// through the app's normal render() call (the caller triggers it).
	I18n.setLang = function (next) {
		lang = next === "zh" ? "zh" : "en";
		try {
			localStorage.setItem(STORAGE_KEY, lang);
		} catch (e) {
			/* private mode */
		}
		if (typeof document !== "undefined") {
			document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
			document.title = I18n.t("Lake Biwa Ride Companion");
			// Segmented switch: raise the active segment, sink the other —
			// aria-pressed carries semantics while data-active slides the
			// raised thumb across the track.
			var langSwitch = document.getElementById("biwa-lang-switch");
			if (langSwitch) {
				langSwitch.dataset.active = lang;
				langSwitch
					.querySelectorAll(".biwa-lang-option")
					.forEach(function (btn) {
						btn.setAttribute(
							"aria-pressed",
							String(btn.getAttribute("data-lang") === lang),
						);
					});
				// The slide is enabled only after the switch has painted once —
				// a saved Chinese preference lands on 中文 instantly at load,
				// never sliding across on the very first frame.
				if (!langSwitch.classList.contains("is-settled")) {
					requestAnimationFrame(function () {
						langSwitch.classList.add("is-settled");
					});
				}
			}
			I18n.applyStatic();
		}
	};

	I18n.toggle = function () {
		I18n.setLang(lang === "zh" ? "en" : "zh");
	};

	// Saved choice wins; otherwise follow the browser language so Chinese
	// readers land on 中文 without a tap.
	try {
		lang =
			localStorage.getItem(STORAGE_KEY) ||
			(typeof navigator !== "undefined" &&
			(navigator.language || "").indexOf("zh") === 0
				? "zh"
				: "en");
	} catch (e) {
		lang = "en";
	}

	if (typeof module !== "undefined" && module.exports) module.exports = I18n;
	global.BiwaI18n = I18n;
})(typeof window !== "undefined" ? window : globalThis);
