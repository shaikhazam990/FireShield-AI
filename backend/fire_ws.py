#!/usr/bin/env python3
"""
FireShield AI — Python Detection Bridge (fire_ws.py)
Outputs JSON lines to stdout so Node.js can parse them.
Run by the Node backend via child_process.spawn().
"""
import sys
import json
import time
import math
import os
import argparse
import threading
from datetime import datetime

# ── Optional imports (gracefully degrade) ─────────────────
try:
    from ultralytics import YOLO
    import cv2
    import cvzone
    YOLO_AVAILABLE = True
except ImportError:
    YOLO_AVAILABLE = False
    print(json.dumps({"type": "warn", "message": "YOLO/OpenCV not installed — demo mode"}), flush=True)

try:
    from playsound import playsound
    SOUND_AVAILABLE = True
except ImportError:
    SOUND_AVAILABLE = False

try:
    import smtplib, ssl
    from email.mime.text import MIMEText
    from email.mime.multipart import MIMEMultipart
    SMTP_AVAILABLE = True
except ImportError:
    SMTP_AVAILABLE = False


# ── Config ─────────────────────────────────────────────────
CONFIDENCE_THRESHOLD = 0.75
ALARM_COOLDOWN       = 2.0
EMAIL_COOLDOWN       = 300
ALARM_FILE           = 'alarm.mp3'
DETECTIONS_DIR       = 'detections'

# Email (read from environment)
SENDER_EMAIL    = os.getenv('SENDER_EMAIL', '')
SENDER_PASSWORD = os.getenv('SENDER_PASSWORD', '')
RECEIVER_EMAIL  = os.getenv('RECEIVER_EMAIL', '')


def emit(obj: dict):
    """Print a JSON line to stdout for Node.js to parse."""
    print(json.dumps(obj), flush=True)


def send_email():
    if not SMTP_AVAILABLE or not SENDER_EMAIL:
        return
    try:
        msg = MIMEMultipart()
        msg['From']    = SENDER_EMAIL
        msg['To']      = RECEIVER_EMAIL
        msg['Subject'] = 'FireShield AI — Fire Detected!'
        body = f'Fire detected at {datetime.now().strftime("%Y-%m-%d %H:%M:%S")}'
        msg.attach(MIMEText(body, 'plain'))
        ctx = ssl.create_default_context()
        with smtplib.SMTP_SSL('smtp.gmail.com', 465, context=ctx) as s:
            s.login(SENDER_EMAIL, SENDER_PASSWORD)
            s.sendmail(SENDER_EMAIL, RECEIVER_EMAIL, msg.as_string())
    except Exception as e:
        emit({"type": "error", "message": f"Email failed: {e}"})


def play_alarm_async():
    if SOUND_AVAILABLE and os.path.exists(ALARM_FILE):
        threading.Thread(target=playsound, args=(ALARM_FILE,), daemon=True).start()


def save_screenshot(frame, confidence):
    if not os.path.exists(DETECTIONS_DIR):
        os.makedirs(DETECTIONS_DIR)
    ts   = datetime.now().strftime('%Y%m%d_%H%M%S')
    name = f'fire_{ts}_{int(confidence*100)}.jpg'
    path = os.path.join(DETECTIONS_DIR, name)
    cv2.imwrite(path, frame)
    return name


def run_detection(model_path: str):
    if not YOLO_AVAILABLE:
        emit({"type": "error", "message": "YOLO not available"})
        sys.exit(1)

    emit({"type": "info", "message": f"Loading model: {model_path}"})
    model = YOLO(model_path)
    emit({"type": "info", "message": "Model loaded"})

    cap = cv2.VideoCapture(0)
    if not cap.isOpened():
        cap = cv2.VideoCapture(1)
    if not cap.isOpened():
        emit({"type": "error", "message": "No webcam found"})
        sys.exit(1)

    cap.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

    # Warm up
    for _ in range(10):
        cap.read()
        time.sleep(0.05)

    last_alarm_time = 0.0
    last_email_time = 0.0
    fps_start   = time.time()
    fps_counter = 0
    fps_val     = 0.0

    emit({"type": "info", "message": "Detection started"})

    while True:
        ret, frame = cap.read()
        if not ret or frame is None:
            time.sleep(0.01)
            continue

        results       = model(frame, stream=True, verbose=False)
        fire_detected = False
        best_conf     = 0.0
        now           = time.time()

        for info in results:
            for box in info.boxes:
                conf   = float(box.conf[0])
                cls_id = int(box.cls[0])
                if conf >= CONFIDENCE_THRESHOLD:
                    fire_detected = True
                    if conf > best_conf:
                        best_conf = conf

                    x1, y1, x2, y2 = map(int, box.xyxy[0])
                    cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 0, 255), 3)
                    pct = math.ceil(conf * 100)
                    cvzone.putTextRect(frame, f'fire {pct}%', [x1+8, y1+100],
                                       scale=1.5, thickness=2, colorR=(180, 0, 0))

        # FPS
        fps_counter += 1
        elapsed = now - fps_start
        if elapsed >= 1.0:
            fps_val     = fps_counter / elapsed
            fps_counter = 0
            fps_start   = now

        # Alarm + email
        if fire_detected:
            if (now - last_alarm_time) > ALARM_COOLDOWN:
                play_alarm_async()
                last_alarm_time = now
                save_screenshot(frame, best_conf)

            if (now - last_email_time) > EMAIL_COOLDOWN:
                threading.Thread(target=send_email, daemon=True).start()
                last_email_time = now

        # Emit JSON frame event to Node.js
        emit({
            "type":          "frame",
            "fire_detected": fire_detected,
            "confidence":    round(best_conf * 100, 1),
            "fps":           round(fps_val, 1),
            "timestamp":     datetime.now().isoformat(),
        })

    cap.release()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', default='models/fire.pt')
    args = parser.parse_args()
    run_detection(args.model)
