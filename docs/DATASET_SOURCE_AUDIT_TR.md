# Dataset Source Audit

Bu not, kullanici tarafindan onerilen veri setlerini `hemen kullan`, `yeni pipeline gerekir` ve `lisans/kullanim riski` olarak ayirir.
Odak: mevcut interview fine-tune akisi.

## Hemen kullan

Bu kaynaklar metin tabanli, acik erisimli ve mevcut `question -> answer` akisina dogrudan uyarlanabilir.

| Kaynak | Durum | Neden |
| --- | --- | --- |
| [AnthropicInterviewer](https://huggingface.co/datasets/Anthropic/AnthropicInterviewer) | Kullanimda | MIT lisansli. Transcript icinden interview-style soru/cevap ciftleri cikarmak mumkun. |
| [OpenAssistant/oasst1](https://huggingface.co/datasets/OpenAssistant/oasst1) | Filtreli kullan | Apache-2.0. Teknik/interview anahtar kelime filtreleriyle kullanilabilir. |
| [Anthropic/hh-rlhf](https://huggingface.co/datasets/Anthropic/hh-rlhf) | Filtreli kullan | MIT lisansli. Son insan soru + secilmis yardimci cevabi, domain keyword filtreleriyle alinabilir. |
| [Tech Interview Handbook](https://github.com/yangshun/tech-interview-handbook) | Crawl seed | MIT lisansli. Interview prep metni icin dogrudan uygun. |
| [kdn251/interviews](https://github.com/kdn251/interviews) | Crawl seed | MIT lisansli. Teknik mulakat icerigi yuksek sinyalli. |
| [awesome-scalability](https://github.com/binhnguyennus/awesome-scalability) | Crawl seed | MIT lisansli. Sistem tasarimi ve buyuk sistemler icin uygun. |
| [javascript-algorithms](https://github.com/trekhleb/javascript-algorithms) | Crawl seed | MIT lisansli. Algoritma ve veri yapilari icin uygun. |
| [awesome-interview](https://github.com/umitkacar/awesome-interview) | Crawl seed | MIT lisansli. Behavioral + coding + system design kapsami var. |
| [JavaScript Algorithms Turkish README](https://github.com/trekhleb/javascript-algorithms/blob/master/README.tr-TR.md) | TR seed | Upstream repoda dogrudan `README.tr-TR.md` dosyasi var. RAG ve TR kavram kapsami icin uygun. |
| [Azure Architecture TR docs](https://learn.microsoft.com/tr-tr/azure/architecture/) | TR seed | Resmi Microsoft Turkce mimari dokumantasyonu. API, microservices ve cloud architecture kapsami icin uygun. |
| [Azure RAG / GenAI TR docs](https://learn.microsoft.com/tr-tr/azure/developer/ai/advanced-retrieval-augmented-generation) | TR seed | RAG, retrieval ve GenAI operasyonlari icin resmi Turkce icerik sagliyor. |
| [Azure MLOps TR docs](https://learn.microsoft.com/tr-tr/azure/architecture/ai-ml/guide/genaiops-for-mlops) | TR seed | MLOps/GenAIOps kapsamini Turkce metinle genisletiyor. |
| [React TR docs](https://tr.react.dev/learn) | TR seed | Resmi React Turkce dokumantasyonu; frontend ve state management kapsami icin kullanilabilir. |

## Yeni pipeline gerekir

Bu kaynaklar faydali, ama mevcut text fine-tune akisina dogrudan uymaz.

| Kaynak | Durum | Gerekce |
| --- | --- | --- |
| [Granary](https://huggingface.co/datasets/nvidia/Granary) | Ayrik speech pipeline | Ses + cviri odakli. STT/MT egitimi icin uygun, interview text QA icin dogrudan degil. |
| [CoVoST 2](https://huggingface.co/datasets/facebook/covost2) | Ayrik speech pipeline | Speech translation veri seti. Text interview cevabi icin dogrudan degil. |
| [Speech-MASSIVE](https://huggingface.co/datasets/FBK-MT/Speech-MASSIVE) | Ayrik SLU pipeline | NLU/slot/intent gorevleri agirlikli. |
| [AMI Meeting Corpus](https://groups.inf.ed.ac.uk/ami/corpus/) | Ayrik meeting pipeline | Meeting audio, diarization ve multimodal isleme gerekiyor. |
| [Europarl / OPUS](https://opus.nlpl.eu/Europarl.php) | Ayrik MT pipeline | Paralel cümleler var, ama interview answer fine-tune icin sekil donusumu gerekiyor. |
| [FLEURS](https://huggingface.co/datasets/google/fleurs) | Ayrik ASR pipeline | Multilingual speech benchmark. |
| [VoxPopuli](https://huggingface.co/datasets/facebook/voxpopuli) | Ayrik ASR pipeline | Parlamento speech agirlikli, text interview answer icin dolayli kaynak. |
| TED-LIUM / TED transcriptleri | Ayrik ASR pipeline | Speech recognition agirlikli. |
| Turkish speech corpus / Common Voice Turkish | Ayrik ASR pipeline | STT tarafinda degerli, mevcut QA builder icin degil. |
| Turkish Speech Corpus (TSC) | Ayrik ASR pipeline | Turkce ASR icin uygun; mevcut text interview fine-tune yerine speech stack'te kullanilmali. |
| InCroMin | Arastirma sonrasi | Eslestirme ve cviri/meeting senaryosu icin degerli olabilir, ama mevcut akisa uyumlu importer yok. |
| Learner corpora (LINDSEI, ICNALE, TLC vb.) | Arastirma sonrasi | Konusma yeterliligi ve dil ogrenimi icin yararli; interview answer tonu icin yeni etiketleme gerekir. |

## Lisans veya kullanim riski

Bu kaynaklar teknik olarak acik gorunse bile, su anki urun hedefi icin otomatik egitime sokulmamali.

| Kaynak | Risk |
| --- | --- |
| [DailyDialog](https://huggingface.co/datasets/li2017dailydialog/daily_dialog) | `CC-BY-NC-SA-4.0`; non-commercial. |
| [CoVoST 2](https://huggingface.co/datasets/facebook/covost2) | `CC-BY-NC-4.0`; non-commercial. |
| [Speech-MASSIVE](https://huggingface.co/datasets/FBK-MT/Speech-MASSIVE) | `CC-BY-NC-SA-4.0`; non-commercial/share-alike. |
| [NPR Media Dialog Transcripts](https://www.npr.org/about-npr/179878450/terms-of-use) | NPR icerigi kullanim kosullarina tabi; otomatik egitim icin temiz degil. |
| NewsInterview (NPR/CNN tabanli) | Altta yatan medya haklari netlestirilmeden riskli. |
| RecruitView | Acik dagitim ve kullanim kosullari net degil. |
| LDC corpus ailesi | [LDC katalogu](https://catalog.ldc.upenn.edu/) uzerinden lisansli/ucretli. Otomatik dahil edilemez. |
| Switchboard, Fisher, CALLHOME, CALLFRIEND, Turkish Broadcast News vb. | Tipik olarak LDC lisansina bagli. |
| [LMSYS-Chat-1M](https://huggingface.co/datasets/lmsys/lmsys-chat-1m) | Gated dataset license agreement gerekiyor. |

## Domain olarak zayif veya dikkatli kullan

Bu kaynaklar acik olsa bile interview assistant kalitesini dogrudan yukseltmeyebilir.

| Kaynak | Not |
| --- | --- |
| [PsyQA](https://huggingface.co/datasets/lsy641/PsyQA) | MIT, ama psikoloji QA. Domain uzak. |
| [Counsel Chat](https://huggingface.co/datasets/nbertagnolli/counsel-chat) | Lisans metadatasi net degil, terapi domaini uzak. |
| WildChat, SHP, orca/tulu/open-perfectblend benzeri genel SFT setleri | Yardimci olabilir ama interview-focused filtreleme olmadan veri dagilimini bozar. |

## Uygulanan karar

1. `AnthropicInterviewer`, `OpenAssistant/oasst1`, `hh-rlhf` icin importer eklendi.
2. Dis `question/reply` JSONL kaynagi `build_finetune_dataset.py` icine baglandi.
3. Kalite raporu artik dis QA satirlarinin `quality_score` degerlerini de hesaba katiyor.
4. MIT lisansli interview repo seedleri `configs/web_corpus_sources.yaml` icine genisletildi.
5. Turkce teknik kapsami artirmak icin `javascript-algorithms`, Azure Architecture, Azure RAG/MLOps ve React'in resmi Turkce sayfalari seed olarak eklendi.

## Turkce ceviri durumu notu

| Kaynak | Durum |
| --- | --- |
| [The System Design Primer](https://github.com/donnemartin/system-design-primer) | Upstream repoda Turkce dosya yok. [TRANSLATIONS.md](https://github.com/donnemartin/system-design-primer/blob/master/TRANSLATIONS.md) icinde Turkce durum `Stalled / Help Wanted` olarak listeleniyor; baglanti bir eski PR/discussion zincirine gidiyor. Bunu otomatik seed olarak eklemek icin once sabit bir kaynak secmek gerekir. |
| [JavaScript Algorithms](https://github.com/trekhleb/javascript-algorithms) | Upstream repoda canli Turkce dosya var: `README.tr-TR.md`. Bu nedenle dogrudan seed olarak kullanilabilir. |
