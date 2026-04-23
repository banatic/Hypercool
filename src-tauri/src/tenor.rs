use regex::Regex;

pub async fn search_tenor(
    query: &str,
    _offset: u32,
) -> Result<serde_json::Value, Box<dyn std::error::Error + Send + Sync>> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")
        .build()?;

    let url = if query.trim().is_empty() {
        "https://tenor.com/".to_string()
    } else {
        let encoded = query.trim().replace(' ', "-");
        format!("https://tenor.com/search/{}-gifs", encoded)
    };

    let html = client
        .get(&url)
        .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .header("Accept-Language", "ko-KR,ko;q=0.9,en-US;q=0.8")
        .send()
        .await?
        .text()
        .await?;

    eprintln!("[tenor] HTML 수신 크기: {} bytes", html.len());

    let pattern = r#"(?is)<figure[^>]*>.*?<img[^>]*src="([^"]+\.gif)"[^>]*alt="([^"]*)""#;
    let re = Regex::new(pattern)?;

    let mut gifs = Vec::new();
    let mut seen_urls = std::collections::HashSet::new();

    for cap in re.captures_iter(&html) {
        if let (Some(src), Some(alt)) = (cap.get(1), cap.get(2)) {
            let url = src.as_str().to_string();
            let title = alt.as_str().to_string();

            if !seen_urls.insert(url.clone()) {
                continue;
            }

            gifs.push(serde_json::json!({
                "id": url.clone(),
                "title": title,
                "preview_url": url.clone(),
                "embed_url": url.clone(),
                "original_url": url.clone(),
            }));
        }
    }

    eprintln!("[tenor] 크롤링 완료: {}개 GIF 수집", gifs.len());

    let count = gifs.len() as u64;
    Ok(serde_json::json!({
        "gifs": gifs,
        "total_count": count,
        "offset": 0,
        "source": "tenor"
    }))
}
