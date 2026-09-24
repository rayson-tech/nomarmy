// nomArmy's macOS notifier (nomArmy.app, built by lib/notifier-app.mjs).
//
// macOS shows a notification with the icon of the app that sent it, so
// osascript's `display notification` always showed Script Editor's. This app
// carries nomArmy's icon and posts through UserNotifications. lib/notify.mjs
// drops one file per notification into the spool folder (argv[1]): title on
// the first line, message on the second. The app posts everything waiting,
// looping in case more arrive while it runs, then quits.
import Foundation
import UserNotifications

let spool = URL(fileURLWithPath: CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ".")
let center = UNUserNotificationCenter.current()
let fm = FileManager.default

func waiting() -> [URL] {
  ((try? fm.contentsOfDirectory(at: spool, includingPropertiesForKeys: nil)) ?? [])
    .filter { $0.pathExtension == "txt" }
    .sorted { $0.lastPathComponent < $1.lastPathComponent }
}

let done = DispatchSemaphore(value: 0)
// The first time, macOS asks the person whether nomArmy may notify.
center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
  guard granted else {
    // Denied: nothing will ever show, so don't let the spool pile up.
    for file in waiting() { try? fm.removeItem(at: file) }
    done.signal()
    return
  }
  for _ in 0..<20 {
    let files = waiting()
    if files.isEmpty { break }
    let group = DispatchGroup()
    for file in files {
      let text = (try? String(contentsOf: file, encoding: .utf8)) ?? ""
      try? fm.removeItem(at: file)
      let lines = text.split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
      let content = UNMutableNotificationContent()
      content.title = lines.first ?? "nomArmy"
      content.body = lines.count > 1 ? lines[1].trimmingCharacters(in: .whitespacesAndNewlines) : ""
      group.enter()
      center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)) { _ in group.leave() }
    }
    group.wait()
  }
  done.signal()
}
// A permission prompt nobody answers mustn't keep the app running forever.
_ = done.wait(timeout: .now() + 120)
// Let the notification service take delivery before the process exits.
Thread.sleep(forTimeInterval: 1)
