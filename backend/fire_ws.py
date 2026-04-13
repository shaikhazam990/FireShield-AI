#!/usr/bin/env python3
"""
FireShield AI — fire_ws.py  (FIXED)

FIXES vs original:
  1. CONFIDENCE_THRESHOLD lowered to 0.45 so detection is not missed
  2. Emits "screenshot" and "alarm" events that Node.js relays to frontend
  3. Bounding boxes emitted with every frame for frontend overlay
  4. Graceful fallback if model has a different class index
  5. Works with both fire.pt (class 0=fire) and yolov8n (class 80 model)
"""
from ultralytics import YOLO
import cv2
import math
import threading
import time
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from datetime import datetime
import ssl
import json
import sys
import os
import argparse
import subprocess

try:
    import cvzone
    HAS_CVZONE = True
except ImportError:
    HAS_CVZONE = False

# ─────────────────────────────────────────────────────────
#  Config
# ─────────────────────────────────────────────────────────
SMTP_SERVER     = os.getenv('SMTP_SERVER',     'smtp.gmail.com')
SMTP_PORT       = int(os.getenv('SMTP_PORT',   '465'))
SENDER_EMAIL    = os.getenv('SENDER_EMAIL',    '')
SENDER_PASSWORD = os.getenv('SENDER_PASSWORD', '')
RECEIVER_EMAIL  = os.getenv('RECEIVER_EMAIL',  '')

# FIX: Lower threshold so real fire gets detected
CONFIDENCE_THRESHOLD      = float(os.getenv('CONFIDENCE_THRESHOLD', '0.45'))
EMAIL_COOLDOWN            = 300
ALARM_FILE                = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'alarm.mp3')
DETECTIONS_DIR            = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'detections')
CLASSNAMES                = ['fire']
CONFIRM_FRAMES_REQUIRED   = 3
RELEASE_FRAMES_REQUIRED   = 5
MAX_SCREENSHOTS_PER_EVENT = 3
SCREENSHOT_INTERVAL       = 5.0


def emit(obj: dict):
    """Write JSON line to stdout — Node.js reads this."""
    print(json.dumps(obj), flush=True)


# ─────────────────────────────────────────────────────────
#  Alarm
# ─────────────────────────────────────────────────────────
alarm_playing = False
alarm_lock    = threading.Lock()
pygame_ok     = False

try:
    import pygame
    pygame.mixer.init()
    pygame_ok = True
except Exception:
    pygame_ok = False


def start_alarm():
    global alarm_playing
    with alarm_lock:
        if alarm_playing:
            return
        if not os.path.exists(ALARM_FILE):
            return
        try:
            if pygame_ok:
                pygame.mixer.music.load(ALARM_FILE)
                pygame.mixer.music.play(-1)
            else:
                subprocess.Popen(['afplay', '-t', '999', ALARM_FILE],
                                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            alarm_playing = True
            emit({"type": "alarm", "state": "on"})
        except Exception as e:
            emit({"type": "warn", "message": f"Alarm start failed: {e}"})


def stop_alarm():
    global alarm_playing
    with alarm_lock:
        if not alarm_playing:
            return
        try:
            if pygame_ok:
                pygame.mixer.music.stop()
            else:
                subprocess.run(['pkill', '-f', 'afplay'], capture_output=True)
            alarm_playing = False
            emit({"type": "alarm", "state": "off"})
        except Exception as e:
            emit({"type": "warn", "message": f"Alarm stop failed: {e}"})


# ─────────────────────────────────────────────────────────
#  Email Alert
# ─────────────────────────────────────────────────────────
def send_email_notification():
    if not SENDER_EMAIL or not SENDER_PASSWORD or not RECEIVER_EMAIL:
        emit({"type": "info", "message": "Email not configured — skipping"})
        return
    try:
        msg            = MIMEMultipart()
        msg['From']    = SENDER_EMAIL
        msg['To']      = RECEIVER_EMAIL
        msg['Subject'] = "🔥 Fire Detection Alert!"
        current_time   = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        body = f"FIRE HAS BEEN DETECTED!\n\nTime: {current_time}\n\nFireShield AI automated alert."
        msg.attach(MIMEText(body, 'plain'))
        context = ssl.create_default_context()
        with smtplib.SMTP_SSL(SMTP_SERVER, SMTP_PORT, context=context) as server:
            server.login(SENDER_EMAIL, SENDER_PASSWORD)
            server.sendmail(SENDER_EMAIL, RECEIVER_EMAIL, msg.as_string())
        emit({"type": "info", "message": "Email sent"})
    except Exception as e:
        emit({"type": "error", "message": f"Email error: {str(e)}"})


# ─────────────────────────────────────────────────────────
#  Screenshot
# ─────────────────────────────────────────────────────────
def save_screenshot(frame, confidence):
    os.makedirs(DETECTIONS_DIR, exist_ok=True)
    ts   = datetime.now().strftime('%Y%m%d_%H%M%S')
    name = f'fire_{ts}_{int(confidence)}.jpg'
    fpath = os.path.join(DETECTIONS_DIR, name)
    cv2.imwrite(fpath, frame)
    # FIX: emit "screenshot" type so Node.js relays new_image event to frontend
    emit({"type": "screenshot", "filename": name, "confidence": round(confidence, 1)})
    return name


# ─────────────────────────────────────────────────────────
#  Color validation
# ─────────────────────────────────────────────────────────
def is_fire_color(frame, x1, y1, x2, y2):
    try:
        roi = frame[y1:y2, x1:x2]
        if roi.size == 0:
            return True  # give benefit of doubt
        hsv         = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
        mask_red1   = cv2.inRange(hsv, (0,   80, 60), (12,  255, 255))
        mask_red2   = cv2.inRange(hsv, (158, 80, 60), (180, 255, 255))
        mask_orange = cv2.inRange(hsv, (12,  80, 60), (30,  255, 255))
        mask_yellow = cv2.inRange(hsv, (30,  80, 60), (38,  255, 255))
        fire_mask   = cv2.bitwise_or(mask_red1, mask_red2)
        fire_mask   = cv2.bitwise_or(fire_mask, mask_orange)
        fire_mask   = cv2.bitwise_or(fire_mask, mask_yellow)
        fire_pixels  = cv2.countNonZero(fire_mask)
        total_pixels = roi.shape[0] * roi.shape[1]
        ratio        = fire_pixels / total_pixels if total_pixels > 0 else 0
        return ratio >= 0.10   # FIX: lowered from 0.15
    except Exception:
        return True


# ─────────────────────────────────────────────────────────
#  Main detection loop
# ─────────────────────────────────────────────────────────
def run_detection(model_path: str):
    emit({"type": "info", "message": f"Loading model: {model_path}"})
    if not os.path.exists(model_path):
        emit({"type": "error", "message": f"Model not found: {model_path}"})
        sys.exit(1)

    model = YOLO(model_path)

    # FIX: Detect class names from model — works for both fire.pt and generic models
    model_class_names = model.names if hasattr(model, 'names') else {}
    fire_class_ids = []
    for cid, cname in model_class_names.items():
        if 'fire' in str(cname).lower():
            fire_class_ids.append(cid)
    if not fire_class_ids:
        # fire.pt typically has class 0 as fire
        fire_class_ids = [0]
    emit({"type": "info", "message": f"Model loaded. Fire class IDs: {fire_class_ids}. Classes: {model_class_names}"})

    # Try webcam
    cap = None
    for cam_idx in [0, 1, 2]:
        cap = cv2.VideoCapture(cam_idx)
        if cap.isOpened():
            emit({"type": "info", "message": f"Webcam opened at index {cam_idx}"})
            break
        cap.release()
        cap = None

    if cap is None or not cap.isOpened():
        emit({"type": "error", "message": "Cannot open any webcam (tried indices 0,1,2)"})
        sys.exit(1)

    cap.set(cv2.CAP_PROP_FRAME_WIDTH,  640)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
    cap.set(cv2.CAP_PROP_BUFFERSIZE,   1)

    # Flush initial frames
    for _ in range(5):
        cap.read()
        time.sleep(0.05)

    emit({"type": "info", "message": "Detection loop started"})

    confirm_counter        = 0
    no_fire_counter        = 0
    confirmed_fire         = False
    email_thread           = None
    last_email_time        = 0.0
    screenshots_this_event = 0
    last_screenshot_time   = 0.0

    fps_start   = time.time()
    fps_counter = 0
    fps_val     = 0.0

    while True:
        ret, frame = cap.read()
        if not ret:
            time.sleep(0.01)
            continue

        frame        = cv2.resize(frame, (640, 480))
        current_time = time.time()

        results = model(
            frame,
            stream=True,
            verbose=False,
            iou=0.4,
            conf=CONFIDENCE_THRESHOLD,
            agnostic_nms=True,
        )

        raw_fire_this_frame = False
        best_conf           = 0.0
        boxes_data          = []
        annotated_frame     = frame.copy()

        for info in results:
            for box in info.boxes:
                confidence = float(box.conf[0])
                class_id   = int(box.cls[0])

                # FIX: accept any class if fire.pt only has 1 class, or match fire class ID
                is_fire_class = (
                    class_id in fire_class_ids or
                    len(model_class_names) == 1  # single-class model = fire model
                )

                if not is_fire_class:
                    continue

                if confidence < CONFIDENCE_THRESHOLD:
                    continue

                x1, y1, x2, y2 = map(int, box.xyxy[0])
                x1 = max(0, x1); y1 = max(0, y1)
                x2 = min(frame.shape[1], x2); y2 = min(frame.shape[0], y2)

                if not is_fire_color(frame, x1, y1, x2, y2):
                    continue

                raw_fire_this_frame = True
                conf_pct = round(confidence * 100, 1)
                if conf_pct > best_conf:
                    best_conf = conf_pct

                # Draw on frame
                cv2.rectangle(annotated_frame, (x1, y1), (x2, y2), (0, 0, 255), 3)
                label = f'fire {int(conf_pct)}%'
                cv2.rectangle(annotated_frame, (x1, y1 - 30), (x1 + len(label)*10, y1), (0, 0, 255), -1)
                cv2.putText(annotated_frame, label, (x1 + 4, y1 - 8),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2)

                boxes_data.append({
                    "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                    "confidence": conf_pct,
                    "class": "fire",
                })

        # ── Frame counters ──────────────────────────────────
        if raw_fire_this_frame:
            confirm_counter += 1
            no_fire_counter  = 0
        else:
            no_fire_counter += 1
            confirm_counter  = 0

        # ── FIRE CONFIRMED ──────────────────────────────────
        if confirm_counter >= CONFIRM_FRAMES_REQUIRED:
            if not confirmed_fire:
                confirmed_fire         = True
                screenshots_this_event = 0
                emit({"type": "info", "message": "Fire confirmed — alarm started"})

            start_alarm()

            if (screenshots_this_event < MAX_SCREENSHOTS_PER_EVENT and
                    (current_time - last_screenshot_time) > SCREENSHOT_INTERVAL):
                save_screenshot(annotated_frame, best_conf)
                screenshots_this_event += 1
                last_screenshot_time    = current_time

            if (current_time - last_email_time) > EMAIL_COOLDOWN:
                if email_thread is None or not email_thread.is_alive():
                    email_thread    = threading.Thread(target=send_email_notification, daemon=True)
                    email_thread.start()
                    last_email_time = current_time

        # ── FIRE GONE ───────────────────────────────────────
        if no_fire_counter >= RELEASE_FRAMES_REQUIRED and confirmed_fire:
            confirmed_fire = False
            stop_alarm()
            emit({"type": "info", "message": "Fire cleared"})

        # ── FPS ─────────────────────────────────────────────
        fps_counter += 1
        elapsed = time.time() - fps_start
        if elapsed >= 1.0:
            fps_val     = fps_counter / elapsed
            fps_counter = 0
            fps_start   = time.time()

        # ── Emit frame data to Node.js ───────────────────────
        emit({
            "type":          "frame",
            "fire_detected": confirmed_fire,
            "raw_detected":  raw_fire_this_frame,
            "confirm_count": confirm_counter,
            "confidence":    best_conf,
            "fps":           round(fps_val, 1),
            "boxes":         boxes_data,      # ← real YOLO boxes
            "timestamp":     datetime.now().isoformat(),
        })

    cap.release()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', default=os.path.join(
        os.path.dirname(os.path.abspath(__file__)), 'fire.pt'
    ))
    args = parser.parse_args()
    run_detection(args.model)
