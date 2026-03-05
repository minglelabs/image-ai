# Business Diagram Studio

정보 입력 중심으로 벤다이어그램과 Competitive Quadrant Chart를 빠르게 만드는 React/Vite 기반 캔버스 앱입니다.

## 주요 기능

- 메인 화면에서 기존 프로젝트 열기 / 신규 프로젝트 생성
- 신규 프로젝트 타입 선택
  - `Venn Diagram`
  - `Competitive Quadrant`
- 캔버스 기반 편집
  - 텍스트박스 추가
  - 이미지 다중 첨부
  - 텍스트/이미지 드래그 이동
  - 텍스트/이미지 리사이즈
- Venn 전용 정보 입력
  - 각 집합 이름
  - 각 집합 아이콘/이미지
  - 서비스 이름/아이콘
- Quadrant 전용 정보 입력
  - x축 / y축 이름
  - 서비스 이름/아이콘
- 로컬 SoT 저장
  - `.project-saves/*.business-diagram-project.json` 파일 기반 저장
  - 0.1초(100ms) 간격 자동 저장

## 시작하기

```bash
cd business-diagram-studio
npm install
npm run dev
```

`npm run dev` 실행 시 Web(Vite) + Local API가 함께 실행됩니다.

## 빌드

```bash
npm run build
npm run preview
```
