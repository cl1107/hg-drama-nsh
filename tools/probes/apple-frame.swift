// [DEBUG-playback-validation] Extract one frame using the same Apple media stack as Video.
import Foundation
import AVFoundation
import AppKit
@main struct FrameProbe {
 static func main() async throws {
  guard CommandLine.arguments.count == 3 else { fatalError("input.mp4 output.png") }
  let asset = AVURLAsset(url: URL(fileURLWithPath: CommandLine.arguments[1]))
  let generator = AVAssetImageGenerator(asset: asset)
  generator.appliesPreferredTrackTransform = true
  let (frame, actualTime) = try await generator.image(at: CMTime(seconds: 60, preferredTimescale: 600))
  let image = NSBitmapImageRep(cgImage: frame)
  try image.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
  print("AVFoundation frame: \(frame.width)x\(frame.height) at \(actualTime.seconds)s")
 }
}
