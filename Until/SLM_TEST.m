% =========================================================================
% 生成“中心高斯 + 平坦过渡 + 边缘最高峰”复合光斑，并使用 FFT 预览
% =========================================================================

clear; clc; close all;

% 1. 参数设置 (可根据操控目标的实际物理尺寸进行调节)
N = 512;               % 矩阵大小
R_max = 50;            % 外边缘最大半径 (像素) -> 势垒的最外侧
w_in = 8;              % 中心高斯峰的宽度参数 (控制中心亮斑的胖瘦)
w_out = 10;            % 边缘反高斯势垒的宽度参数 (控制势垒向内滑落的缓急)

% 光强比例设置 (必须满足 I_outer > I_inner > I_flat)
I_outer = 1.0;         % 外部最边缘的光强峰值 (归一化为1)
I_inner = 0.7;         % 中心高斯的光强峰值 (设为外圈的 70%)
I_flat = 0.2;          % 中间过渡平顶区的基底光强 (设为外圈的 20%)
iter_num = 100;        % GS算法迭代次数

% 2. 构造目标光强分布 (Target Intensity)
[X, Y] = meshgrid(-N/2 : N/2-1, -N/2 : N/2-1);
R = sqrt(X.^2 + Y.^2);

% 数学构造：基底光强 + 中心高斯衰减 + 边缘高斯衰减
I_target = I_flat ...
         + (I_inner - I_flat) * exp(-R.^2 / (2 * w_in^2)) ...
         + (I_outer - I_flat) * exp(-(R - R_max).^2 / (2 * w_out^2));

% 硬截断：超出外边缘的区域直接置为 0，形成光壁
I_target(R > R_max) = 0;

% 将光强转换为振幅 (A = sqrt(I))，输入给 GS 算法
target_amp = sqrt(I_target);

% 3. Gerchberg-Saxton (GS) 算法提取相位
source_amp = ones(N, N);             
slm_phase = 2 * pi * rand(N, N);     

for k = 1:iter_num
    % SLM平面 -> 焦平面
    E_slm = source_amp .* exp(1i * slm_phase);
    E_focal = fftshift(fft2(E_slm));
    
    % 替换为目标振幅
    focal_phase = angle(E_focal);
    E_focal_modified = target_amp .* exp(1i * focal_phase);
    
    % 焦平面 -> SLM平面
    E_slm_back = ifft2(ifftshift(E_focal_modified));
    
    % 提取更新后的相位
    slm_phase = angle(E_slm_back);
end

% 4. 快速预览
E_final = source_amp .* exp(1i * slm_phase);
E_preview = fftshift(fft2(E_final));
I_preview = abs(E_preview).^2;       
I_preview = I_preview / max(I_preview(:)); % 光强归一化至 1

% 5. 取截面查看光强分布曲线 (验证平顶和双峰高度)
mid_row = N/2 + 1;
cross_section_target = I_target(mid_row, :);
cross_section_preview = I_preview(mid_row, :);

% 6. 绘图显示
figure('Name', '复合光斑设计与预览', 'Position', [100, 100, 1400, 400]);

% 子图1：目标光强截面曲线 (直观查看设计是否符合要求)
subplot(1,4,1);
plot(-N/2:N/2-1, cross_section_target, 'k-', 'LineWidth', 2);
xlim([-R_max-20, R_max+20]); ylim([0, 1.1]);
title('目标光强截面曲线'); xlabel('像素距离'); ylabel('归一化光强');
grid on;

% 子图2：理想二维目标光强
subplot(1,4,2);
imagesc(I_target); colormap(gca, 'gray'); axis image off;
title('理想目标光强分布');

% 子图3：计算所得 SLM 相位图
subplot(1,4,3);
imagesc(slm_phase); colormap(gca, 'gray'); axis image off;
title('SLM 相位图');

% 子图4：FFT 预览最终衍射光强
subplot(1,4,4);
imagesc(I_preview); colormap(gca, 'jet'); axis image off;
title('FFT 预览最终光强');