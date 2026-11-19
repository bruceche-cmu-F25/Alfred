// Apple's on-device recognizer (SpeechAnalyzer + SpeechTranscriber, macOS 26). Needs the macOS 26 SDK to build.
//
//   apple <locale> <jobs.json>      prints one JSON line per clip: {"id","text","ms"} or {"id","error","ms"}
//
// jobs.json: [{"id": "...", "wav": "/abs/path.wav"}]. SpeechTranscriber takes no vocabulary hints, so there is no context.
import AVFoundation
import Foundation
import Speech

struct Job: Decodable { let id: String; let wav: String }

func emit(_ fields: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: fields)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}

func transcribe(_ url: URL, locale: Locale) async throws -> String {
  let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
  let analyzer = SpeechAnalyzer(modules: [transcriber])
  let file = try AVAudioFile(forReading: url)
  async let text = transcriber.results.reduce(into: "") { out, result in
    if result.isFinal { out += String(result.text.characters) }
  }
  if let last = try await analyzer.analyzeSequence(from: file) {
    try await analyzer.finalizeAndFinish(through: last)
  } else {
    await analyzer.cancelAndFinishNow()
  }
  return try await text
}

@main
struct Apple {
  static func main() async {
    let args = CommandLine.arguments
    guard args.count == 3 else {
      FileHandle.standardError.write("usage: apple <locale> <jobs.json>\n".data(using: .utf8)!)
      exit(2)
    }
    do {
      guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: args[1])) else {
        let all = await SpeechTranscriber.supportedLocales.map(\.identifier).sorted().joined(separator: " ")
        FileHandle.standardError.write("locale \(args[1]) not supported; supported: \(all)\n".data(using: .utf8)!)
        exit(3)
      }
      // The model for this locale is downloaded by the system the first time.
      let probe = SpeechTranscriber(locale: locale, preset: .transcription)
      if let request = try await AssetInventory.assetInstallationRequest(supporting: [probe]) {
        try await request.downloadAndInstall()
      }
      let jobs = try JSONDecoder().decode([Job].self, from: Data(contentsOf: URL(fileURLWithPath: args[2])))
      if let first = jobs.first { _ = try? await transcribe(URL(fileURLWithPath: first.wav), locale: locale) } // warm-up
      for job in jobs {
        let start = Date()
        do {
          let text = try await transcribe(URL(fileURLWithPath: job.wav), locale: locale)
          emit(["id": job.id, "text": text, "ms": Int(Date().timeIntervalSince(start) * 1000)])
        } catch {
          emit(["id": job.id, "error": String(describing: error), "ms": Int(Date().timeIntervalSince(start) * 1000)])
        }
      }
    } catch {
      FileHandle.standardError.write("\(error)\n".data(using: .utf8)!)
      exit(1)
    }
  }
}
