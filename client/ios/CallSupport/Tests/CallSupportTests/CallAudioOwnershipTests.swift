import Foundation
import XCTest
@testable import CallSupport

private final class AudioDriver: CallAudioDriver {
    var manualAudio = false
    var audioEnabled = false
    var active = false
    var references = 0
    var activations = 0
    var deactivations = 0
    var failActivation = false

    func activate() throws {
        if failActivation { throw NSError(domain: "test", code: 1) }
        activations += 1
        references += 1
        active = true
    }

    func deactivate() {
        deactivations += 1
        references -= 1
        if references == 0 { active = false }
    }

    // Mirrors RTCAudioSession's external activation accounting.
    func systemActivated() { references += 1; active = true }
    func systemDeactivated() { references -= 1; active = false }
}

final class CallAudioOwnershipTests: XCTestCase {
    func testLateDeactivationOfAReactivatesOutgoingBWithoutLosingItsAudio() throws {
        let driver = AudioDriver()
        let audio = CallAudioOwnership(driver: driver)
        audio.expectCallKit(callId: "A")
        audio.didActivate(notifySDK: driver.systemActivated)
        try audio.begin(callId: "A")
        audio.end(callId: "A")
        XCTAssertEqual(driver.deactivations, 0, "A borrowed CallKit's session; it must not deactivate it")

        try audio.begin(callId: "B")
        XCTAssertTrue(driver.audioEnabled)
        XCTAssertNil(audio.didDeactivate(notifySDK: driver.systemDeactivated))
        XCTAssertTrue(driver.audioEnabled)
        XCTAssertTrue(driver.active, "restoring the enable flag alone leaves the SDK session inactive")
        XCTAssertEqual(driver.references, 1)
        audio.end(callId: "A") // a stale teardown must not end B
        XCTAssertTrue(driver.audioEnabled)
        audio.end(callId: "B")
        XCTAssertEqual(driver.references, 0)
        XCTAssertFalse(driver.manualAudio)
    }

    func testIncomingCallWaitsForItsOwnActivationAndResumesAfterInterruption() throws {
        let driver = AudioDriver()
        let audio = CallAudioOwnership(driver: driver)
        audio.expectCallKit(callId: "A")
        try audio.begin(callId: "A")
        XCTAssertFalse(driver.audioEnabled)
        XCTAssertEqual(driver.activations, 0)
        audio.didActivate(notifySDK: driver.systemActivated)
        XCTAssertTrue(driver.audioEnabled)
        XCTAssertNil(audio.didDeactivate(notifySDK: driver.systemDeactivated))
        XCTAssertFalse(driver.audioEnabled)
        XCTAssertEqual(driver.activations, 0, "do not override a system interruption")
        audio.didActivate(notifySDK: driver.systemActivated)
        XCTAssertTrue(driver.audioEnabled)
        audio.end(callId: "A")
        XCTAssertEqual(driver.deactivations, 0)
        XCTAssertNil(audio.didDeactivate(notifySDK: driver.systemDeactivated))
        XCTAssertEqual(driver.references, 0)
    }

    func testEndingBeforeMediaBeginsDoesNotTouchAnotherAudioOwner() {
        let driver = AudioDriver()
        driver.audioEnabled = true // channel voice, outside this coordinator
        let audio = CallAudioOwnership(driver: driver)
        audio.end(callId: "never-started")
        XCTAssertTrue(driver.audioEnabled)
        audio.didActivate(notifySDK: driver.systemActivated)
        XCTAssertNil(audio.didDeactivate(notifySDK: driver.systemDeactivated))
        XCTAssertTrue(driver.audioEnabled)
        XCTAssertEqual(driver.activations, 0)
        XCTAssertEqual(driver.deactivations, 0)
    }

    func testLateActivationDoesNotReenableAnEndedCall() throws {
        let driver = AudioDriver()
        let audio = CallAudioOwnership(driver: driver)
        audio.expectCallKit(callId: "A")
        try audio.begin(callId: "A")
        audio.end(callId: "A")
        _ = audio.callKitCallEnded(callId: "A")
        audio.didActivate(notifySDK: driver.systemActivated)
        XCTAssertFalse(driver.audioEnabled)
        XCTAssertNil(audio.didDeactivate(notifySDK: driver.systemDeactivated))
        XCTAssertEqual(driver.references, 0)
    }

    func testIncomingBDoesNotBorrowAsStillActiveCallKitSession() throws {
        let driver = AudioDriver()
        let audio = CallAudioOwnership(driver: driver)
        audio.expectCallKit(callId: "A")
        audio.didActivate(notifySDK: driver.systemActivated)
        audio.expectCallKit(callId: "B")
        try audio.begin(callId: "B")
        XCTAssertFalse(driver.audioEnabled)
        _ = audio.didDeactivate(notifySDK: driver.systemDeactivated)
        audio.didActivate(notifySDK: driver.systemActivated)
        XCTAssertTrue(driver.audioEnabled)
    }

    func testSameCallCanLeaveCallKitWithoutLosingMediaOrUnbalancingReferences() throws {
        let driver = AudioDriver()
        let audio = CallAudioOwnership(driver: driver)
        audio.expectCallKit(callId: "A")
        audio.didActivate(notifySDK: driver.systemActivated)
        try audio.begin(callId: "A")
        XCTAssertNil(audio.callKitCallEnded(callId: "A"))
        XCTAssertNil(audio.didDeactivate(notifySDK: driver.systemDeactivated))
        XCTAssertTrue(driver.active)
        XCTAssertTrue(driver.audioEnabled)
        try audio.begin(callId: "A") // idempotent
        XCTAssertEqual(driver.references, 1)
        audio.end(callId: "A")
        XCTAssertEqual(driver.references, 0)
    }

    func testFailedRestorationReturnsCurrentOwnerForTeardown() throws {
        let driver = AudioDriver()
        let audio = CallAudioOwnership(driver: driver)
        audio.didActivate(notifySDK: driver.systemActivated)
        try audio.begin(callId: "B")
        driver.failActivation = true
        XCTAssertEqual(audio.didDeactivate(notifySDK: driver.systemDeactivated), "B")
        XCTAssertFalse(driver.audioEnabled)
        audio.end(callId: "B")
        XCTAssertEqual(driver.references, 0)
    }

    func testFailedInitialActivationDoesNotReleaseSomeoneElsesReference() {
        let driver = AudioDriver()
        let audio = CallAudioOwnership(driver: driver)
        audio.didActivate(notifySDK: driver.systemActivated)
        driver.failActivation = true
        XCTAssertThrowsError(try audio.begin(callId: "B"))
        audio.end(callId: "B")
        XCTAssertEqual(driver.deactivations, 0)
        XCTAssertEqual(driver.references, 1)
    }
}
