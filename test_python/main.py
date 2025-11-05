from pywinauto import Application
from pywinauto.findwindows import ElementNotFoundError
import time

class SimpleMessengerMonitor:
    def __init__(self, process_name=None, title=None):
        """
        process_name: 프로세스 이름 (예: "KakaoTalk.exe")
        title: 윈도우 타이틀 (예: "카카오톡")
        """
        self.process_name = process_name
        self.title = title
        self.app = None
    
    def connect(self):
        """메신저 프로세스에 연결"""
        try:
            if self.process_name:
                self.app = Application(backend="uia").connect(process=self.process_name)
            elif self.title:
                self.app = Application(backend="uia").connect(title_re=f".*{self.title}.*")
            else:
                raise ValueError("process_name 또는 title 중 하나는 필요합니다")
            
            print(f"✅ 연결 성공!")
            return True
        except Exception as e:
            print(f"❌ 연결 실패: {e}")
            return False
    
    def get_window_info(self):
        """현재 윈도우 정보 출력"""
        if not self.app:
            return
        
        try:
            window = self.app.top_window()
            print(f"\n=== 윈도우 정보 ===")
            print(f"제목: {window.window_text()}")
            print(f"클래스: {window.class_name()}")
            print(f"핸들: {window.handle}")
            
            # 자식 요소들 출력
            print(f"\n=== 자식 요소들 (상위 20개) ===")
            controls = window.descendants()[:20]
            
            for i, ctrl in enumerate(controls):
                try:
                    print(f"{i+1}. [{ctrl.control_type()}] {ctrl.automation_id()} : {ctrl.window_text()[:50]}")
                except:
                    pass
                    
        except Exception as e:
            print(f"오류: {e}")
    
    def monitor_text_changes(self, interval=1):
        """텍스트 변경 감시"""
        if not self.app:
            return
        
        previous_texts = {}
        print(f"\n🔍 {interval}초 간격으로 모니터링 시작... (Ctrl+C로 중단)")
        
        try:
            while True:
                try:
                    window = self.app.top_window()
                    current_texts = {}
                    
                    # 텍스트가 있는 컨트롤만 수집
                    for ctrl in window.descendants():
                        try:
                            text = ctrl.window_text()
                            if text and len(text.strip()) > 0:
                                ctrl_id = f"{ctrl.control_type()}_{ctrl.automation_id()}"
                                current_texts[ctrl_id] = text
                        except:
                            continue
                    
                    # 변경 감지
                    if previous_texts:
                        for ctrl_id, text in current_texts.items():
                            if ctrl_id not in previous_texts:
                                print(f"\n📌 새 요소: {ctrl_id}")
                                print(f"   내용: {text[:100]}")
                            elif previous_texts[ctrl_id] != text:
                                print(f"\n🔄 변경 감지: {ctrl_id}")
                                print(f"   이전: {previous_texts[ctrl_id][:100]}")
                                print(f"   현재: {text[:100]}")
                    
                    previous_texts = current_texts
                    
                except ElementNotFoundError:
                    print("⚠️  윈도우를 찾을 수 없음")
                
                time.sleep(interval)
                
        except KeyboardInterrupt:
            print("\n\n✋ 모니터링 중단")

# 사용 예시
if __name__ == "__main__":
    # 방법 1: 프로세스 이름으로 연결
    # monitor = SimpleMessengerMonitor(process_name="KakaoTalk.exe")
    
    # 방법 2: 윈도우 타이틀로 연결
    monitor = SimpleMessengerMonitor(title="COOLMESSENGER")
    
    if monitor.connect():
        # 윈도우 구조 파악
        monitor.get_window_info()
        
        # 변경 사항 모니터링
        monitor.monitor_text_changes(interval=0.5)