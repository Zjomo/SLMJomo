import numpy as np
import matplotlib.pyplot as plt

# ====== 参数设置 ======
rows = 1024          # SLM 纵向像素数
cols = 1024          # SLM 横向像素数
period = 256         # 每个光栅周期的像素数（推荐 256，便于整除）

# ====== 计算跳变点 ======
jump1 = int(period / 6)      # 1/6 处，0→π   (42)
jump2 = int(period / 2)      # 1/2 处，π→0   (128)

# ====== 生成一个周期的相位灰度值（0 和 255） ======
pattern = np.zeros(period, dtype=np.uint8)
pattern[jump1:jump2] = 255   # 中间 1/3 区域设为 255（相位 π）

# ====== 平铺成一行 ======
row_full = np.tile(pattern, (cols // period) + 1)[:cols]  # 保证恰好 1024 列

# ====== 扩展为整个二维矩阵（所有行相同） ======
slm_matrix = np.tile(row_full, (rows, 1))

# ====== 保存为 8 位灰度图像（可直接加载到 SLM） ======
plt.imsave('dammann_1x3.png', slm_matrix, cmap='gray', vmin=0, vmax=255)

# ====== 打印矩阵基本信息 ======
print(f"矩阵形状: {slm_matrix.shape}")
print(f"数值范围: {slm_matrix.min()} ~ {slm_matrix.max()}")
print("已保存为 dammann_1x3.png，请用 SLM 软件加载。")