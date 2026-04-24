use reqwest::blocking::Client;
use scraper::{Html, Selector};
use serde::{Serialize, Deserialize};
use std::collections::HashMap;
use std::sync::OnceLock;
use chrono::Datelike;

static ALLERGY_REGEX: OnceLock<regex::Regex> = OnceLock::new();

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MealData {
    pub lunch: String,
    pub dinner: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LatecomerData {
    pub student_info: String,
    pub arrival_time: String,
    pub attendance_status: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PointsData {
    pub student_info: String,
    pub reward: i32,
    pub penalty: i32,
    pub offset: i32,
    pub total: i32,
}

// NEIS API로 급식 데이터 가져오기
pub fn fetch_meal_data(date: &str, atpt_code: &str, school_code: &str) -> Result<MealData, String> {
    let url = format!(
        "https://open.neis.go.kr/hub/mealServiceDietInfo?Type=json&ATPT_OFCDC_SC_CODE={}&SD_SCHUL_CODE={}&MLSV_YMD={}",
        atpt_code, school_code, date
    );

    let client = Client::new();
    let response = client.get(&url)
        .send()
        .map_err(|e| format!("API 요청 실패: {}", e))?
        .text()
        .map_err(|e| format!("응답 읽기 실패: {}", e))?;

    // JSON 파싱
    let json: serde_json::Value = serde_json::from_str(&response)
        .map_err(|e| format!("JSON 파싱 실패: {}", e))?;

    let mut lunch = "금일 중식 없습니다.".to_string();
    let mut dinner = "금일 석식 없습니다.".to_string();

    if let Some(meal_info) = json["mealServiceDietInfo"].get(1) {
        if let Some(rows) = meal_info["row"].as_array() {
            for row in rows.iter() {
                if let Some(ddish_nm) = row["DDISH_NM"].as_str() {
                    // <br/> 제거 및 줄바꿈 처리
                    let menu = ddish_nm.replace("<br/>", "\n");
                    
                    // 알레르기 정보 제거 (괄호 안의 숫자 제거)
                    let re = ALLERGY_REGEX.get_or_init(|| regex::Regex::new(r"\s*\([^)]*\)").unwrap());
                    let menu = re.replace_all(&menu, "").to_string();
                    
                    // 중식/석식 구분
                    if let Some(mmeal_sc_nm) = row["MMEAL_SC_NM"].as_str() {
                        if mmeal_sc_nm.contains("중식") {
                            lunch = menu.clone();
                        } else if mmeal_sc_nm.contains("석식") {
                            dinner = menu;
                        }
                    }
                }
            }
        }
    }

    Ok(MealData { lunch, dinner })
}

// 내부망에서 출결 데이터 가져오기
pub fn fetch_attendance_data(grade: &str, class: &str) -> Result<(Vec<LatecomerData>, String), String> {
    let base_url = "http://10.122.1.10";
    
    // Session 생성 (Python의 requests.Session()과 동일)
    let jar = std::sync::Arc::new(reqwest::cookie::Jar::default());
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .cookie_provider(jar.clone())
        .build()
        .map_err(|e| format!("클라이언트 생성 실패: {}", e))?;

    // 1단계: 로그인 페이지 접속
    let login_page = client.get(base_url)
        .send()
        .map_err(|e| format!("로그인 페이지 접속 실패: {}", e))?
        .text()
        .map_err(|e| format!("응답 읽기 실패: {}", e))?;

    let document = Html::parse_document(&login_page);
    let viewstate = document.select(&Selector::parse("input[name='__VIEWSTATE']").unwrap())
        .next().and_then(|el| el.value().attr("value")).unwrap_or("");
    let viewstategen = document.select(&Selector::parse("input[name='__VIEWSTATEGENERATOR']").unwrap())
        .next().and_then(|el| el.value().attr("value")).unwrap_or("");
    let eventvalid = document.select(&Selector::parse("input[name='__EVENTVALIDATION']").unwrap())
        .next().and_then(|el| el.value().attr("value")).unwrap_or("");

    // 2단계: 로그인 (session.post처럼 동작)
    let mut form_data = HashMap::new();
    form_data.insert("__VIEWSTATE", viewstate);
    form_data.insert("__VIEWSTATEGENERATOR", viewstategen);
    form_data.insert("__EVENTVALIDATION", eventvalid);
    form_data.insert("txt_id", "신민성");
    form_data.insert("txt_pw", "1111");
    form_data.insert("btn_login", "로그인");

    let _login_response = client.post(base_url)
        .form(&form_data)
        .send()
        .map_err(|e| format!("로그인 실패: {}", e))?;

    // 3단계: 출결 페이지 접속 (세션이 유지됨)
    let attendance_url = format!("{}/Pages/Student/AttendanceCertify.aspx", base_url);
    
    let attendance_page = client.get(&attendance_url)
        .send()
        .map_err(|e| format!("출결 페이지 접속 실패: {}", e))?
        .text()
        .map_err(|e| format!("응답 읽기 실패: {}", e))?;

    let document = Html::parse_document(&attendance_page);
    let viewstate = document.select(&Selector::parse("input[name='__VIEWSTATE']").unwrap())
        .next().and_then(|el| el.value().attr("value")).unwrap_or("");
    let viewstategen = document.select(&Selector::parse("input[name='__VIEWSTATEGENERATOR']").unwrap())
        .next().and_then(|el| el.value().attr("value")).unwrap_or("");
    let eventvalid = document.select(&Selector::parse("input[name='__EVENTVALIDATION']").unwrap())
        .next().and_then(|el| el.value().attr("value")).unwrap_or("");

    // 4단계: 조회 요청 (session.post처럼 동작)
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let mut form_data = HashMap::new();
    form_data.insert("__EVENTTARGET", "");
    form_data.insert("__EVENTARGUMENT", "");
    form_data.insert("__VIEWSTATE", viewstate);
    form_data.insert("__VIEWSTATEGENERATOR", viewstategen);
    form_data.insert("__EVENTVALIDATION", eventvalid);
    form_data.insert("ctl00$ContentPlaceHolder1$txt_date", &today);
    form_data.insert("ctl00$ContentPlaceHolder1$ddl_grade", grade);
    form_data.insert("ctl00$ContentPlaceHolder1$ddl_class", class);
    form_data.insert("ctl00$ContentPlaceHolder1$btn_select", "선택");
    form_data.insert("ctl00$ContentPlaceHolder1$txt_inTime", "");
    form_data.insert("ctl00$ContentPlaceHolder1$MaskedEditExtender1_ClientState", "");
    form_data.insert("ctl00$ContentPlaceHolder1$rbg", "rboDL");
    form_data.insert("ctl00$ContentPlaceHolder1$ddl_AttType", "L");
    form_data.insert("ctl00$ContentPlaceHolder1$hhd_idx", "");
    form_data.insert("ctl00$ContentPlaceHolder1$hhd_gradeno", "");
    form_data.insert("ctl00$ContentPlaceHolder1$hhd_attidx", "");
    form_data.insert("ctl00$ContentPlaceHolder1$hhd_OriType", "");
    form_data.insert("ctl00$ContentPlaceHolder1$hid_checkedIDs", "");

    let result_page = client.post(&attendance_url)
        .form(&form_data)
        .send()
        .map_err(|e| format!("조회 요청 실패: {}", e))?
        .text()
        .map_err(|e| format!("응답 읽기 실패: {}", e))?;
    
    // HTML 저장 (디버깅용)
    let debug_html = result_page.clone();

    // 5단계: HTML 파싱 (Python 코드 참고)
    let document = Html::parse_document(&result_page);
    
    // 모든 테이블 찾기 (Python처럼)
    let table_selector = Selector::parse("table").unwrap();
    let row_selector = Selector::parse("tr").unwrap();
    let cell_selector = Selector::parse("td, th").unwrap(); // Python처럼 td, th 모두 사용

    let mut latecomers = Vec::new();
    let mut header_found = false;
    let mut student_info_idx = 0;
    let mut arrival_time_idx = 1;
    let mut attendance_status_idx = 2;

    for table in document.select(&table_selector) {
        for (idx, row) in table.select(&row_selector).enumerate() {
            let cells: Vec<_> = row.select(&cell_selector).collect();
            if cells.is_empty() {
                continue;
            }

            // 첫 번째 행에서 헤더 찾기 (Python의 clean_attendance_df 로직)
            if idx == 0 {
                let header_texts: Vec<String> = cells.iter()
                    .map(|c| c.text().collect::<String>().trim().to_string())
                    .collect();
                
                // 헤더가 "출결사항" 또는 "등교시간"을 포함하는지 확인
                let has_attendance_header = header_texts.iter()
                    .any(|h| h.contains("출결사항") || h.contains("등교시간"));
                
                if has_attendance_header {
                    header_found = true;
                    // 컬럼 인덱스 찾기
                    for (i, text) in header_texts.iter().enumerate() {
                        if text.contains("학생정보") || text.contains("학생 이름") {
                            student_info_idx = i;
                        } else if text.contains("등교시간") {
                            arrival_time_idx = i;
                        } else if text.contains("출결사항") || text.contains("출석종류") {
                            attendance_status_idx = i;
                        }
                    }
                    continue;
                }
            }

            // 헤더를 찾았거나, 헤더가 없으면 첫 번째 행부터 데이터로 처리
            if cells.len() >= 3 && (header_found || idx > 0) {
                let student_info = if student_info_idx < cells.len() {
                    cells[student_info_idx].text().collect::<String>().trim().to_string()
                } else {
                    String::new()
                };
                
                let arrival_time = if arrival_time_idx < cells.len() {
                    cells[arrival_time_idx].text().collect::<String>().trim().to_string()
                } else {
                    String::new()
                };
                
                let attendance_status = if attendance_status_idx < cells.len() {
                    cells[attendance_status_idx].text().collect::<String>().trim().to_string()
                } else {
                    String::new()
                };

                // Python의 clean_attendance_df 필터링 로직
                if !student_info.is_empty() 
                    && student_info.contains("학년")
                    && student_info.contains("반")
                    && !student_info.contains("학생정보")
                    && !student_info.contains("학생 이름")
                    && !student_info.contains("출석종류")
                    && !student_info.contains("등교종류")
                    && !student_info.contains("번호")
                    && student_info.len() > 5 {
                    latecomers.push(LatecomerData {
                        student_info,
                        arrival_time,
                        attendance_status,
                    });
                }
            }
        }
        
        // 첫 번째 테이블에서 데이터를 찾으면 종료
        if !latecomers.is_empty() {
            break;
        }
    }

    Ok((latecomers, debug_html))
}

// 내부망에서 상벌점 데이터 가져오기
pub fn fetch_points_data(grade: &str, class: &str) -> Result<(Vec<PointsData>, String), String> {
    let base_url = "http://10.122.1.10";
    
    // Session 생성 (출결 데이터와 동일하게 cookie_provider 사용)
    let jar = std::sync::Arc::new(reqwest::cookie::Jar::default());
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .cookie_provider(jar.clone())
        .build()
        .map_err(|e| format!("클라이언트 생성 실패: {}", e))?;

    // 1단계: 로그인
    let login_page = client.get(base_url)
        .send()
        .map_err(|e| format!("로그인 페이지 접속 실패: {}", e))?
        .text()
        .map_err(|e| format!("응답 읽기 실패: {}", e))?;

    let document = Html::parse_document(&login_page);
    let viewstate = document.select(&Selector::parse("input[name='__VIEWSTATE']").unwrap())
        .next().and_then(|el| el.value().attr("value")).unwrap_or("");
    let viewstategen = document.select(&Selector::parse("input[name='__VIEWSTATEGENERATOR']").unwrap())
        .next().and_then(|el| el.value().attr("value")).unwrap_or("");
    let eventvalid = document.select(&Selector::parse("input[name='__EVENTVALIDATION']").unwrap())
        .next().and_then(|el| el.value().attr("value")).unwrap_or("");

    let mut form_data = HashMap::new();
    form_data.insert("__VIEWSTATE", viewstate);
    form_data.insert("__VIEWSTATEGENERATOR", viewstategen);
    form_data.insert("__EVENTVALIDATION", eventvalid);
    form_data.insert("txt_id", "신민성");
    form_data.insert("txt_pw", "1111");
    form_data.insert("btn_login", "로그인");

    let _login_response = client.post(base_url)
        .form(&form_data)
        .send()
        .map_err(|e| format!("로그인 실패: {}", e))?;

    // 2단계: 상벌점 페이지 접속 (세션이 유지됨)
    let points_url = format!("{}/Pages/Point/PointStudent.aspx", base_url);
    
    let points_page = client.get(&points_url)
        .send()
        .map_err(|e| format!("상벌점 페이지 접속 실패: {}", e))?
        .text()
        .map_err(|e| format!("응답 읽기 실패: {}", e))?;

    let document = Html::parse_document(&points_page);
    let viewstate = document.select(&Selector::parse("input[name='__VIEWSTATE']").unwrap())
        .next().and_then(|el| el.value().attr("value")).unwrap_or("");
    let viewstategen = document.select(&Selector::parse("input[name='__VIEWSTATEGENERATOR']").unwrap())
        .next().and_then(|el| el.value().attr("value")).unwrap_or("");
    let eventvalid = document.select(&Selector::parse("input[name='__EVENTVALIDATION']").unwrap())
        .next().and_then(|el| el.value().attr("value")).unwrap_or("");

    // 3단계: 조회 요청
    let start_date = chrono::Local::now().with_month(1).unwrap().with_day(1).unwrap().format("%Y-%m-%d").to_string();
    let end_date = chrono::Local::now().format("%Y-%m-%d").to_string();

    let mut form_data = HashMap::new();
    form_data.insert("__EVENTTARGET", "");
    form_data.insert("__EVENTARGUMENT", "");
    form_data.insert("__VIEWSTATE", viewstate);
    form_data.insert("__VIEWSTATEGENERATOR", viewstategen);
    form_data.insert("__EVENTVALIDATION", eventvalid);
    form_data.insert("ctl00$ContentPlaceHolder1$txt_start", &start_date);
    form_data.insert("ctl00$ContentPlaceHolder1$txt_end", &end_date);
    form_data.insert("ctl00$ContentPlaceHolder1$ddl_grade", grade);
    form_data.insert("ctl00$ContentPlaceHolder1$ddl_class", class);
    form_data.insert("ctl00$ContentPlaceHolder1$txt_name", "");
    form_data.insert("ctl00$ContentPlaceHolder1$btn_select", "조회");

    let result_page = client.post(&points_url)
        .form(&form_data)
        .send()
        .map_err(|e| format!("조회 요청 실패: {}", e))?
        .text()
        .map_err(|e| format!("응답 읽기 실패: {}", e))?;
    
    // HTML 저장 (디버깅용)
    let debug_html = result_page.clone();

    // 4단계: HTML 파싱
    let document = Html::parse_document(&result_page);
    
    // ContentPlaceHolder1_gv_pointList 테이블 찾기
    let table_selector = Selector::parse("table[id='ContentPlaceHolder1_gv_pointList']").unwrap();
    let row_selector = Selector::parse("tr").unwrap();
    let cell_selector = Selector::parse("td").unwrap();

    let mut points_list = Vec::new();

    if let Some(table) = document.select(&table_selector).next() {
        // Python 코드 참고: td[2], td[3], td[4]에서 p 태그 우선, 없으면 직접 텍스트
        let p_selector = Selector::parse("p").unwrap();
        
        for (idx, row) in table.select(&row_selector).enumerate() {
            let cells: Vec<_> = row.select(&cell_selector).collect();
            
            // Python 코드: len(tds) < 6 체크, 헤더 제외
            if cells.len() < 6 || idx == 0 {
                continue;
            }

            // 학생정보: td[0]
            let student_info = cells[0].text().collect::<String>().trim().to_string();
            
            // Python 코드: td[2]에서 p 태그 우선, 없으면 직접 텍스트
            let reward_text = if let Some(p_tag) = cells.get(2).and_then(|c| c.select(&p_selector).next()) {
                p_tag.text().collect::<String>().trim().to_string()
            } else if let Some(cell) = cells.get(2) {
                cell.text().collect::<String>().trim().to_string()
            } else {
                String::new()
            };
            
            // Python 코드: td[3]에서 p 태그 우선, 없으면 직접 텍스트 (벌점은 음수)
            let penalty_text = if let Some(p_tag) = cells.get(3).and_then(|c| c.select(&p_selector).next()) {
                p_tag.text().collect::<String>().trim().to_string()
            } else if let Some(cell) = cells.get(3) {
                cell.text().collect::<String>().trim().to_string()
            } else {
                String::new()
            };
            
            // Python 코드: td[4]에서 p 태그 우선, 없으면 직접 텍스트
            let offset_text = if let Some(p_tag) = cells.get(4).and_then(|c| c.select(&p_selector).next()) {
                p_tag.text().collect::<String>().trim().to_string()
            } else if let Some(cell) = cells.get(4) {
                cell.text().collect::<String>().trim().to_string()
            } else {
                String::new()
            };
            
            // Python의 parse_positive 함수: 숫자만 추출
            let reward = reward_text.chars()
                .filter(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse::<i32>()
                .unwrap_or(0);
            
            // Python의 parse_penalty 함수: 숫자 추출 후 음수로 처리
            let penalty_abs = penalty_text.chars()
                .filter(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse::<i32>()
                .unwrap_or(0);
            let penalty = -penalty_abs; // 항상 음수로 처리
            
            let offset = offset_text.chars()
                .filter(|c| c.is_ascii_digit())
                .collect::<String>()
                .parse::<i32>()
                .unwrap_or(0);
            
            let total = reward + penalty + offset;

            // 학생정보가 "학년"을 포함하고 있고, 헤더가 아닌 경우
            if !student_info.is_empty() 
                && student_info.contains("학년")
                && student_info.contains("반")
                && !student_info.contains("학생정보")
                && !student_info.contains("번호")
                && student_info.len() > 5 {
                points_list.push(PointsData {
                    student_info,
                    reward,
                    penalty,
                    offset,
                    total,
                });
            }
        }
    }
    Ok((points_list, debug_html))
}




    
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StockQuote {
    pub symbol: String,
    pub short_name: String,
    pub regular_market_price: f64,
    pub regular_market_change_percent: f64,
    pub pre_market_price: Option<f64>,
    pub pre_market_change_percent: Option<f64>,
    pub post_market_price: Option<f64>,
    pub post_market_change_percent: Option<f64>,
    pub market_state: String,
    pub currency: String,
}

fn make_client() -> reqwest::blocking::Client {
    reqwest::blocking::ClientBuilder::new()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(12))
        .build()
        .unwrap_or_default()
}

/// 미국 동부 시간(ET) 기준 시장 상태 추정 (공휴일 미반영)
fn us_market_state() -> &'static str {
    use std::time::{SystemTime, UNIX_EPOCH};
    let unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    // 미국 동부: 대략 UTC-4 (EDT, 3월~11월)
    let et = unix - 4 * 3600;
    let dow = ((et / 86400 + 4) % 7) as u32; // 0=Sun
    if dow == 0 || dow == 6 {
        return "CLOSED";
    }
    let mins = ((et % 86400) / 60) as u32;
    match mins {
        240..=569  => "PRE",     // 04:00–09:30
        570..=959  => "REGULAR", // 09:30–16:00
        960..=1199 => "POST",    // 16:00–20:00
        _          => "CLOSED",
    }
}

fn kr_market_state() -> &'static str {
    use std::time::{SystemTime, UNIX_EPOCH};
    let unix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let kst = unix + 9 * 3600;
    let dow = ((kst / 86400 + 4) % 7) as u32;
    let mins = ((kst % 86400) / 60) as u32;
    if dow == 0 || dow == 6 {
        "CLOSED"
    } else if (540..=930).contains(&mins) {
        "REGULAR" // 09:00–15:30
    } else {
        "CLOSED"
    }
}

// ─── CNBC Quote API (미국주식, 프리/장후 포함, 교내망 허용 확인) ──────────────
fn cnbc_market_state(status: &str) -> &'static str {
    match status {
        "PRE_MKT"  => "PRE",
        "REG_MKT"  => "REGULAR",
        "POST_MKT" => "POST",
        _          => "CLOSED",
    }
}

fn fetch_us_from_cnbc(symbols: &[String]) -> Result<Vec<StockQuote>, String> {
    let us_syms: Vec<&String> = symbols.iter().filter(|s| !is_kr_symbol(s)).collect();
    if us_syms.is_empty() {
        return Ok(vec![]);
    }

    let sym_param = us_syms.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("|");
    let url = format!(
        "https://quote.cnbc.com/quote-html-webservice/quote.htm?symbols={}&requestMethod=onload&noform=1&partnerId=2&fund=1&exthrs=1&output=json",
        sym_param
    );

    let client = make_client();
    let resp = client
        .get(&url)
        .header("Referer", "https://www.cnbc.com")
        .send()
        .map_err(|e| format!("CNBC API 요청 실패: {}", e))?;
    let text = resp.text().map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;

    let quotes_arr = json["QuickQuoteResult"]["QuickQuote"]
        .as_array()
        .ok_or("CNBC 응답 형식 오류")?;

    let mut results = Vec::new();
    for q in quotes_arr {
        // code != "0" 은 데이터 없음
        if q["code"].as_str().unwrap_or("3") != "0" {
            continue;
        }

        let symbol = q["symbol"].as_str().unwrap_or("").to_uppercase();
        let name = q["name"].as_str().unwrap_or(&symbol).to_string();

        let price: f64 = q["last"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0);
        let change_pct: f64 = q["change_pct"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0.0);
        let market_state = cnbc_market_state(q["curmktstatus"].as_str().unwrap_or("CLOSE"));

        let ext = &q["ExtendedMktQuote"];
        let (pre_price, pre_pct, post_price, post_pct) = if ext.is_object() {
            let ext_price: Option<f64> = ext["last"].as_str().and_then(|s| s.parse().ok());
            let ext_pct: Option<f64> = ext["change_pct"].as_str().and_then(|s| s.parse().ok());
            match ext["type"].as_str().unwrap_or("") {
                "PRE_MKT"  => (ext_price, ext_pct, None, None),
                "POST_MKT" => (None, None, ext_price, ext_pct),
                _          => (None, None, None, None),
            }
        } else {
            (None, None, None, None)
        };

        results.push(StockQuote {
            symbol,
            short_name: name,
            regular_market_price: price,
            regular_market_change_percent: change_pct,
            pre_market_price: pre_price,
            pre_market_change_percent: pre_pct,
            post_market_price: post_price,
            post_market_change_percent: post_pct,
            market_state: market_state.to_string(),
            currency: "USD".to_string(),
        });
    }

    if results.is_empty() {
        Err("CNBC에서 데이터를 가져오지 못했습니다 (잘못된 종목코드 또는 네트워크 오류)".to_string())
    } else {
        Ok(results)
    }
}

// ─── Google Finance (한국주식, 교내망 허용 확인) ─────────────────────────────
fn is_kr_symbol(s: &str) -> bool {
    let base = s.trim_end_matches(".KS").trim_end_matches(".KQ");
    base.len() == 6 && base.chars().all(|c| c.is_ascii_digit())
}

/// HTML에서 첫 번째 매칭 capture 반환
fn re_find<'a>(pattern: &str, text: &'a str) -> Option<&'a str> {
    let re = regex::Regex::new(pattern).ok()?;
    re.captures(text)?.get(1).map(|m| m.as_str())
}

fn fetch_kr_from_google(symbols: &[String]) -> Vec<StockQuote> {
    let kr_symbols: Vec<&String> = symbols.iter().filter(|s| is_kr_symbol(s)).collect();
    if kr_symbols.is_empty() {
        return vec![];
    }

    let client = make_client();
    let mut results = Vec::new();

    for sym in kr_symbols {
        let code = sym.trim_end_matches(".KS").trim_end_matches(".KQ");
        let exchange = if sym.ends_with(".KQ") { "KOSDAQ" } else { "KRX" };

        let url = format!("https://www.google.com/finance/quote/{}:{}", code, exchange);
        let Ok(resp) = client
            .get(&url)
            .header("Accept-Language", "ko-KR,ko;q=0.9")
            .send()
        else { continue };
        let Ok(html) = resp.text() else { continue };

        // 현재가
        let Some(price_str) = re_find(r#"data-last-price="([^"]+)""#, &html) else { continue };
        let Ok(price) = price_str.replace(',', "").parse::<f64>() else { continue };

        // 회사명
        let name = re_find(r#"class="zzDege">([^<]+)<"#, &html)
            .unwrap_or(code)
            .to_string();

        // 전일 종가: 첫 번째 P6K39c 항목 (통화 기호·쉼표 제거)
        let prev_close = re_find(r#"class="P6K39c">(?:[₩$¥€])?([\d,]+(?:\.\d+)?)<"#, &html)
            .and_then(|s| s.replace(',', "").parse::<f64>().ok())
            .unwrap_or(price);

        let change_pct = if prev_close > 0.0 {
            (price - prev_close) / prev_close * 100.0
        } else {
            0.0
        };

        results.push(StockQuote {
            symbol: sym.clone(),
            short_name: name,
            regular_market_price: price,
            regular_market_change_percent: change_pct,
            pre_market_price: None,
            pre_market_change_percent: None,
            post_market_price: None,
            post_market_change_percent: None,
            market_state: kr_market_state().to_string(),
            currency: "KRW".to_string(),
        });
    }

    results
}

pub fn fetch_stock_data(symbols: &[String]) -> Result<Vec<StockQuote>, String> {
    let mut results: Vec<StockQuote> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    // 한국 주식: Google Finance (교내망 접속 가능)
    let kr = fetch_kr_from_google(symbols);
    results.extend(kr);

    // 미국 주식: CNBC Quote API (교내망 접속 가능, 프리/장후 포함)
    match fetch_us_from_cnbc(symbols) {
        Ok(us) => results.extend(us),
        Err(e) => errors.push(e),
    }

    if results.is_empty() && !errors.is_empty() {
        return Err(errors.join(" / "));
    }

    // 원래 symbols 순서로 정렬
    results.sort_by_key(|q| symbols.iter().position(|s| s == &q.symbol).unwrap_or(usize::MAX));

    Ok(results)
}

#[tauri::command]
pub fn get_stock_quotes(symbols: Vec<String>) -> Result<Vec<StockQuote>, String> {
    fetch_stock_data(&symbols)
}

#[tauri::command]
pub fn get_meal_data(date: String, atpt_code: String, school_code: String) -> Result<MealData, String> {
    fetch_meal_data(&date, &atpt_code, &school_code)
}

#[tauri::command]
pub fn get_attendance_data(grade: String, class: String) -> Result<(Vec<LatecomerData>, String), String> {
    fetch_attendance_data(&grade, &class)
}

#[tauri::command]
pub fn get_points_data(grade: String, class: String) -> Result<(Vec<PointsData>, String), String> {
    fetch_points_data(&grade, &class)
}

