use std::fs;
use std::io::Read;
use std::path::Path;
use std::time::SystemTime;
use serde::{Serialize, Deserialize};
use encoding_rs::EUC_KR;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TimetableData {
    pub teachers: Vec<String>,
    pub subjects: Vec<String>,
    pub timetables: std::collections::HashMap<String, Vec<Vec<Vec<String>>>>, // Teacher -> [Period][Day][Subject, Room]
}

#[derive(Debug, Serialize, Deserialize)]
pub struct TimetableCell {
    pub subject: String,
    pub room: String,
}

pub fn get_latest_gwa_file() -> Option<std::path::PathBuf> {
    let db_path = Path::new(r"C:\Program Files (x86)\알림이\dat");
    if !db_path.exists() {
        return None;
    }

    let mut latest_file = None;
    let mut latest_time = SystemTime::UNIX_EPOCH;

    if let Ok(entries) = fs::read_dir(db_path) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("Gwa") {
                if let Ok(metadata) = fs::metadata(&path) {
                    if let Ok(modified) = metadata.modified() {
                        if modified > latest_time {
                            latest_time = modified;
                            latest_file = Some(path);
                        }
                    }
                }
            }
        }
    }
    latest_file
}

fn decode_cp949(bytes: &[u8]) -> String {
    let (cow, _, _) = EUC_KR.decode(bytes);
    cow.into_owned()
}

pub fn parse_timetable() -> Result<TimetableData, String> {
    let gwa_path = get_latest_gwa_file().ok_or("Gwa file not found")?;
    let file = fs::File::open(&gwa_path).map_err(|e| e.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;

    let mut teachers = Vec::new();
    let mut subjects = Vec::new();
    let mut timetables = std::collections::HashMap::new();

    // 1. Load Teachers
    // Try to find "교사명.kim" handling encoding issues in zip filenames if necessary
    // For now, iterate and check decoded names or just try direct access if names are standard
    // ZipArchive in Rust might treat filenames as UTF-8 or raw bytes.
    // Let's iterate to find files.
    
    let mut teacher_content = Vec::new();
    let mut subject_content = Vec::new();
    let mut timetable_content = Vec::new();

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        // The filename might be CP949 encoded if it was zipped on Windows Korean locale
        // zip crate returns name() as &str (UTF-8), which might be garbled if it was CP949
        // But zip crate has `name_raw()` which returns &[u8].
        let raw_name = file.name_raw();
        let filename = decode_cp949(raw_name);
        
        if filename.contains("교사명.kim") {
            file.read_to_end(&mut teacher_content).map_err(|e| e.to_string())?;
        } else if filename.contains("과목명.kim") {
            file.read_to_end(&mut subject_content).map_err(|e| e.to_string())?;
        } else if filename.contains("기본교사시간표.kim") {
            file.read_to_end(&mut timetable_content).map_err(|e| e.to_string())?;
        }
    }

    if teacher_content.is_empty() || subject_content.is_empty() || timetable_content.is_empty() {
        return Err("Required .kim files not found in archive".to_string());
    }

    // Parse Teachers
    let teacher_str = decode_cp949(&teacher_content);
    for line in teacher_str.lines() {
        if line.trim().is_empty() { continue; }
        for part in line.split('^') {
            let t = part.trim();
            if !t.is_empty() {
                teachers.push(t.to_string());
            }
        }
    }
    // Remove last empty item if it exists (logic from python)
    // Python: self.teachers = [t for t in teachers if t.strip()][0:-1] if len(teachers) > 2 else teachers
    if teachers.len() > 2 {
        teachers.pop();
    }

    // Parse Subjects
    let subject_str = decode_cp949(&subject_content);
    for chunk in subject_str.split('$') {
        if chunk.contains('^') {
            let parts: Vec<&str> = chunk.splitn(2, '^').collect();
            if parts.len() == 2 {
                subjects.push(parts[0].to_string());
            }
        }
    }

    // Parse Timetable
    // Logic from python:
    // chunk_size = 252
    // num_chunks = len(data) // chunk_size
    // for chunk_idx in range(num_chunks):
    //   if chunk_idx >= len(teachers): break
    //   chunk = data[...]
    //   timetable = 8 periods x 5 days
    //   for block_idx in range(8):
    //     base_offset = 32 + block_idx * 28
    //     block = chunk[base_offset : base_offset + 28]
    //     lesson_data = block[:20]
    //     for day in range(5):
    //       offset = day * 4
    //       info = lesson_data[offset : offset + 4]
    //       subject_code_full = int.from_bytes(..., 'little')
    //       subject_code = subject_code_full // 1000
    //       class_code = subject_code_full % 1000
    
    let chunk_size = 252;
    let num_chunks = timetable_content.len() / chunk_size;

    for chunk_idx in 0..num_chunks {
        if chunk_idx >= teachers.len() {
            break;
        }

        let teacher_name = &teachers[chunk_idx];
        let chunk_start = chunk_idx * chunk_size;
        let chunk_end = chunk_start + chunk_size;
        let chunk = &timetable_content[chunk_start..chunk_end];

        let mut timetable_matrix = vec![vec![vec!["".to_string(), "".to_string()]; 5]; 8];

        for block_idx in 0..8 {
            let base_offset = 32 + block_idx * 28;
            if base_offset + 28 > chunk.len() { continue; }
            
            let block = &chunk[base_offset..base_offset + 28];
            let lesson_data = &block[..20];

            for day in 0..5 {
                let offset = day * 4;
                if offset + 4 > lesson_data.len() { continue; }
                
                let info = &lesson_data[offset..offset + 4];
                // u32 from little endian bytes
                let subject_code_full = u32::from_le_bytes([info[0], info[1], info[2], info[3]]);
                let subject_code = subject_code_full / 1000;
                let class_code = subject_code_full % 1000;

                if subject_code_full != 0 {
                    if subject_code > 0 && (subject_code as usize) <= subjects.len() {
                        let subject_name = &subjects[(subject_code as usize) - 1];
                        let room = if class_code > 0 { format!("{}반", class_code) } else { "".to_string() };
                        timetable_matrix[block_idx][day] = vec![subject_name.clone(), room];
                    }
                }
            }
        }
        timetables.insert(teacher_name.clone(), timetable_matrix);
    }

    Ok(TimetableData {
        teachers,
        subjects,
        timetables,
    })
}
